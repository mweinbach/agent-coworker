//! Behavior & workspace defaults settings page (`SettingsPageId::Defaults`).
//!
//! Ported from `apps/desktop/src/ui/settings/pages/WorkspacesPage.tsx` (`surface="defaults"`).

use rune::{El, col, row, text};
use rune_kit::{Button, ButtonVariant, Checkbox, ControlSize, Kit, Select, SelectAppearance};
use serde_json::{Value, json};

use crate::actions::{Action, NativeAction, NavAction, SettingsAction};
use crate::router::SettingsPageId;
use crate::state::{AppState, ServerLifecycleState, WorkspaceRecord, WorkspaceRuntime};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, Section, SettingsRow, StatusTone, confirm_dialog,
    management_targets, mini_switch, settings_page, status_pill, update_desktop_settings,
};
use crate::views::settings::providers::is_provider_connected;
use crate::views::settings::providers_utils::sort_and_filter_providers;
use crate::views::settings::shell::PageContent;

/// Normalized per-workspace tool-calling configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceToolCalling {
    pub deferred_tool_search: bool,
    pub code_mode: bool,
    pub strategy: String,
}

impl Default for WorkspaceToolCalling {
    fn default() -> Self {
        Self {
            deferred_tool_search: false,
            code_mode: false,
            strategy: "auto".to_string(),
        }
    }
}

/// Resolves tool-calling defaults from `workspace.defaults` (supporting both
/// canonical `"toolCalling"` and legacy Electron `"defaultToolCalling"` keys).
pub fn resolve_workspace_tool_calling(
    ws: &WorkspaceRecord,
    runtime: Option<&WorkspaceRuntime>,
) -> WorkspaceToolCalling {
    let raw = ws
        .defaults
        .get("toolCalling")
        .or_else(|| ws.defaults.get("defaultToolCalling"))
        .or_else(|| {
            runtime
                .and_then(|rt| rt.control_session_config.as_ref())
                .and_then(|cfg| cfg.get("toolCalling"))
        });

    let Some(obj) = raw.and_then(Value::as_object) else {
        return WorkspaceToolCalling::default();
    };

    let strategy = match obj.get("strategy").and_then(Value::as_str) {
        Some("native") => "native",
        Some("harness") => "harness",
        _ => "auto",
    };

    WorkspaceToolCalling {
        deferred_tool_search: obj
            .get("deferredToolSearch")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        code_mode: obj
            .get("codeMode")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        strategy: strategy.to_string(),
    }
}

/// Resolves the active non-archived workspace displayed on the Behavior page.
pub fn active_behavior_workspace(s: &AppState) -> Option<&WorkspaceRecord> {
    if let Some(id) = s.resolve_management_workspace_id()
        && let Some(ws) = s.workspaces.iter().find(|w| w.id == id && !w.archived)
    {
        return Some(ws);
    }
    s.workspaces.iter().find(|w| !w.archived)
}

fn feature_enabled(s: &AppState, key: &str) -> bool {
    s.feature_flags.get(key).copied().unwrap_or(true)
}

fn strategy_label(value: &str) -> &'static str {
    match value {
        "native" => "Native provider wire format",
        "harness" => "Cowork harness",
        _ => "Auto (recommended)",
    }
}

fn strategy_from_label(label: &str) -> &'static str {
    match label {
        "Native provider wire format" => "native",
        "Cowork harness" => "harness",
        _ => "auto",
    }
}

fn build_tool_calling_patch(tc: &WorkspaceToolCalling) -> Value {
    json!({
        "toolCalling": {
            "deferredToolSearch": tc.deferred_tool_search,
            "codeMode": tc.code_mode,
            "strategy": tc.strategy,
        }
    })
}

fn sync_workspace_defaults_everywhere(s: &mut AppState, source_id: &str) {
    let Some(src) = s.workspaces.iter().find(|w| w.id == source_id).cloned() else {
        return;
    };

    let mut patch = serde_json::Map::new();
    if let Some(p) = src.default_provider {
        patch.insert("defaultProvider".to_string(), Value::String(p));
    }
    if let Some(m) = src.default_model {
        patch.insert("defaultModel".to_string(), Value::String(m));
    }
    patch.insert(
        "defaultEnableMcp".to_string(),
        Value::Bool(src.default_enable_mcp),
    );
    patch.insert(
        "defaultBackupsEnabled".to_string(),
        Value::Bool(src.default_backups_enabled),
    );
    patch.insert("yolo".to_string(), Value::Bool(src.yolo));
    if let Some(un) = src.user_name {
        patch.insert("userName".to_string(), Value::String(un));
    }
    if let Some(up) = src.user_profile {
        patch.insert("userProfile".to_string(), up);
    }
    if let Some(tc) = src
        .defaults
        .get("toolCalling")
        .or_else(|| src.defaults.get("defaultToolCalling"))
    {
        patch.insert("toolCalling".to_string(), tc.clone());
    }

    let other_ids: Vec<String> = s
        .workspaces
        .iter()
        .filter(|w| !w.archived && w.id != source_id)
        .map(|w| w.id.clone())
        .collect();
    let payload = Value::Object(patch);
    for id in other_ids {
        s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
            workspace_id: id,
            defaults: payload.clone(),
        }));
    }
}

/// Builds the Behavior (`SettingsPageId::Defaults`) settings view.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let workspace_picker_enabled = feature_enabled(s, "workspacePicker");
    let workspace_lifecycle_enabled = feature_enabled(s, "workspaceLifecycle");
    let per_ws = s.desktop_settings.per_workspace_settings;

    let Some(ws) = active_behavior_workspace(s) else {
        let mut empty = EmptyState::new("No workspaces added yet")
            .icon(&icons::FOLDER)
            .description(
                "Add a folder to configure workspace defaults, tool calling behavior, and permissions.",
            );
        if workspace_lifecycle_enabled {
            empty = empty.action(
                Button::new("Add workspace")
                    .variant(ButtonVariant::Contrast)
                    .control_size(ControlSize::Regular)
                    .icon(&icons::PLUS)
                    .on_press(|s: &mut AppState| {
                        s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                    })
                    .build(k),
            );
        }
        return PageContent::simple(settings_page(vec![
            Section::new().child(empty.build(k, t)).build(k, t),
        ]));
    };

    let ws_id = ws.id.clone();
    let ws_name = if ws.one_off_chat {
        "Chats".to_string()
    } else if ws.name.trim().is_empty() {
        ws.path.clone()
    } else {
        ws.name.clone()
    };
    let runtime = s.workspace_runtime_by_id.get(&ws_id);
    let targets = management_targets(s);
    let active_target = targets
        .iter()
        .find(|target| target.id == ws_id)
        .or_else(|| targets.first());

    let mut overlays: Vec<El> = Vec::new();
    let mut sections: Vec<El> = Vec::new();

    if per_ws {
        let mut target_section = Section::new()
            .title("Settings target")
            .description("Selected project or chat group for this settings mode.");
        if workspace_lifecycle_enabled {
            target_section = target_section.action(
                Button::new("Add")
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .icon(&icons::PLUS)
                    .on_press(|s: &mut AppState| {
                        s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                    })
                    .build(k),
            );
        }

        let target_label = active_target
            .map(|target| target.label.clone())
            .unwrap_or_else(|| ws_name.clone());
        let target_path = active_target
            .map(|target| target.path.clone())
            .unwrap_or_else(|| ws.path.clone());

        let mut target_row = SettingsRow::new(target_label).description(target_path);
        if workspace_picker_enabled && targets.len() > 1 {
            let labels: Vec<String> = targets.iter().map(|t| t.label.clone()).collect();
            let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
            let pairs: Vec<(String, String)> = targets
                .iter()
                .map(|t| (t.label.clone(), t.id.clone()))
                .collect();
            let current_label = active_target.map(|t| t.label.clone());
            let select_open =
                s.settings_ui.open_select_key.as_deref() == Some("behavior-settings-target");

            let picker = Select::new("behavior-settings-target", &label_refs)
                .label("Target workspace or chat")
                .appearance(SelectAppearance::Field)
                .width(220.0)
                .current(current_label.as_deref())
                .open(select_open)
                .on_toggle(|s: &mut AppState| {
                    let open = s.settings_ui.open_select_key.as_deref()
                        == Some("behavior-settings-target");
                    s.settings_ui.open_select_key = if open {
                        None
                    } else {
                        Some("behavior-settings-target".to_string())
                    };
                })
                .on_close(|s: &mut AppState| {
                    if s.settings_ui.open_select_key.as_deref() == Some("behavior-settings-target")
                    {
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
            target_row = target_row.control(picker);
        }

        sections.push(target_section.child(target_row.build(k, t)).build(k, t));
    }

    // Execution & visibility defaults
    let exec_desc = if per_ws {
        "Execution and visibility options for this folder or chat."
    } else {
        "Execution and visibility options for all folders and chats."
    };
    let ws_id_mcp = ws_id.clone();
    let enable_mcp = ws.default_enable_mcp;
    let mcp_row = SettingsRow::new("MCP tools")
        .description(
            "Allow configured MCP servers. In ChatGPT Subscription/Codex hybrid mode, Cowork exposes these as dynamic tools while Codex keeps local shell, files, and web native.",
        )
        .control(mini_switch(
            enable_mcp,
            "Enable MCP tools",
            false,
            move |s: &mut AppState| {
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_id_mcp.clone(),
                    defaults: json!({ "defaultEnableMcp": !enable_mcp }),
                }));
            },
            k,
        ));

    let ws_id_yolo = ws_id.clone();
    let yolo = ws.yolo;
    let yolo_row = SettingsRow::new("YOLO mode")
        .description(
            "Never ask for approval and run shell commands outside the OS sandbox with full file and network access.",
        )
        .danger(yolo)
        .control(mini_switch(
            yolo,
            "YOLO mode",
            false,
            move |s: &mut AppState| {
                s.settings_ui.workspace_yolo_confirm = Some((ws_id_yolo.clone(), !yolo));
            },
            k,
        ));

    sections.push(
        Section::new()
            .description(exec_desc)
            .child(mcp_row.build(k, t))
            .child(yolo_row.build(k, t))
            .build(k, t),
    );

    // Tool calling controls
    let tc = resolve_workspace_tool_calling(ws, runtime);
    let ws_id_dts = ws_id.clone();
    let tc_dts = tc.clone();
    let dts_row = SettingsRow::new("Deferred tool search")
        .description(
            "Keep non-core and MCP tool schemas out of the initial prompt and load them on demand when needed.",
        )
        .control(mini_switch(
            tc.deferred_tool_search,
            "Enable deferred tool search",
            false,
            move |s: &mut AppState| {
                let mut next = tc_dts.clone();
                next.deferred_tool_search = !next.deferred_tool_search;
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_id_dts.clone(),
                    defaults: build_tool_calling_patch(&next),
                }));
            },
            k,
        ));

    let ws_id_ptc = ws_id.clone();
    let tc_ptc = tc.clone();
    let ptc_row = SettingsRow::new("Programmatic tool calling (Code Mode)")
        .description(
            "Allow the model to orchestrate multi-step tool pipelines in code instead of sequential round-trips.",
        )
        .control(mini_switch(
            tc.code_mode,
            "Enable programmatic tool calling",
            false,
            move |s: &mut AppState| {
                let mut next = tc_ptc.clone();
                next.code_mode = !next.code_mode;
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_id_ptc.clone(),
                    defaults: build_tool_calling_patch(&next),
                }));
            },
            k,
        ));

    let strategy_labels = [
        "Auto (recommended)",
        "Native provider wire format",
        "Cowork harness",
    ];
    let strategy_open =
        s.settings_ui.open_select_key.as_deref() == Some("behavior-tool-calling-strategy");
    let ws_id_strat = ws_id.clone();
    let tc_strat = tc.clone();
    let strategy_select = Select::new("behavior-tool-calling-strategy", &strategy_labels)
        .label("Execution strategy")
        .appearance(SelectAppearance::Field)
        .width(230.0)
        .current(Some(strategy_label(&tc.strategy)))
        .open(strategy_open)
        .on_toggle(|s: &mut AppState| {
            let open =
                s.settings_ui.open_select_key.as_deref() == Some("behavior-tool-calling-strategy");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("behavior-tool-calling-strategy".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("behavior-tool-calling-strategy") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            let mut next = tc_strat.clone();
            next.strategy = strategy_from_label(chosen).to_string();
            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                workspace_id: ws_id_strat.clone(),
                defaults: build_tool_calling_patch(&next),
            }));
        })
        .build(k, &mut overlays);

    let strategy_row = SettingsRow::new("Execution strategy")
        .description(
            "Auto probes the active provider endpoint and uses native OpenAI, Anthropic, or Codex envelopes when supported, falling back cleanly to the Cowork harness.",
        )
        .control(strategy_select);

    let mut tool_calling_section = Section::new()
        .title("Tool calling")
        .description(
            "Control deferred tool discovery, programmatic multi-tool execution, and native provider wire envelopes.",
        )
        .child(dts_row.build(k, t))
        .child(ptc_row.build(k, t))
        .child(strategy_row.build(k, t));

    if let Some(caps) = runtime.and_then(|rt| rt.capabilities.as_ref())
        && !caps.is_null()
    {
        let mut pills: Vec<El> = Vec::new();
        if let Some(provider) = caps.get("provider").and_then(Value::as_str) {
            let model = caps.get("model").and_then(Value::as_str).unwrap_or("");
            let label = if model.is_empty() {
                provider.to_string()
            } else {
                format!("{provider}: {model}")
            };
            pills.push(status_pill(label, StatusTone::Neutral, k, t));
        }
        let search_supported = caps
            .get("toolRetryLineage")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        pills.push(status_pill(
            if search_supported {
                "Capabilities negotiated"
            } else {
                "Cowork harness active"
            },
            StatusTone::Success,
            k,
            t,
        ));
        tool_calling_section = tool_calling_section.child(
            SettingsRow::new("Active capabilities")
                .body(row().w_full().flex_wrap().gap(6.0).children(pills))
                .build(k, t),
        );
    }

    sections.push(tool_calling_section.build(k, t));

    // Collapsible Advanced actions section
    let adv_open = s.settings_ui.workspace_advanced_open;
    let adv_toggle = SettingsRow::new("Advanced actions")
        .description("Sharing, server restart, and folder/chat removal controls.")
        .control(
            Button::new(if adv_open { "Hide" } else { "Show" })
                .variant(ButtonVariant::Ghost)
                .control_size(ControlSize::Small)
                .icon(if adv_open {
                    &icons::CHEVRON_DOWN
                } else {
                    &icons::CHEVRON_RIGHT
                })
                .on_press(|s: &mut AppState| {
                    s.settings_ui.workspace_advanced_open = !s.settings_ui.workspace_advanced_open;
                })
                .build(k),
        );

    let mut adv_section = Section::new().child(adv_toggle.build(k, t));
    if adv_open {
        let active_ws_count = s.workspaces.iter().filter(|w| !w.archived).count();
        let per_ws_row = SettingsRow::new("Configure settings per folder or chat")
            .description(
                "When enabled, each folder or one-off chat can keep different provider, model, and behavior settings.",
            )
            .control(mini_switch(
                per_ws,
                "Configure settings per folder or chat",
                false,
                move |s: &mut AppState| {
                    let currently_on = s.desktop_settings.per_workspace_settings;
                    if currently_on && active_ws_count > 1 {
                        s.settings_ui.workspace_share_confirm_open = true;
                    } else {
                        update_desktop_settings(s, |next| {
                            next.per_workspace_settings = !currently_on;
                        });
                    }
                },
                k,
            ));
        adv_section = adv_section.child(per_ws_row.build(k, t));

        if workspace_lifecycle_enabled && !ws.one_off_chat {
            let ws_id_restart = ws_id.clone();
            let restarting = runtime
                .is_some_and(|rt| matches!(rt.server_state, ServerLifecycleState::Starting { .. }));
            let restart_row = SettingsRow::new("Restart server")
                .description("Restart the agent server for this folder or chat if unresponsive.")
                .control(
                    Button::new(if restarting {
                        "Restarting…"
                    } else {
                        "Restart"
                    })
                    .variant(ButtonVariant::Outline)
                    .control_size(ControlSize::Small)
                    .icon(&icons::REFRESH_CCW)
                    .disabled(restarting)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Native(NativeAction::RestartWorkspaceServer(
                            ws_id_restart.clone(),
                        )));
                    })
                    .build(k),
                );
            adv_section = adv_section.child(restart_row.build(k, t));

            let ws_id_remove = ws_id.clone();
            let remove_row = SettingsRow::new("Remove from Cowork")
                .description(
                    "Remove this folder or chat from the app. Files on disk are not affected.",
                )
                .danger(true)
                .control(
                    Button::new("Remove")
                        .variant(ButtonVariant::Danger)
                        .control_size(ControlSize::Small)
                        .icon(&icons::TRASH)
                        .on_press(move |s: &mut AppState| {
                            s.settings_ui.workspace_remove_confirm_id = Some(ws_id_remove.clone());
                        })
                        .build(k),
                );
            adv_section = adv_section.child(remove_row.build(k, t));
        }
    }

    sections.push(adv_section.build(k, t));

    // Confirmation modals
    if let Some((confirm_ws_id, next_yolo)) = s.settings_ui.workspace_yolo_confirm.clone() {
        confirm_dialog(
            ConfirmDialogSpec {
                key: "behavior-yolo-confirm",
                open: true,
                title: if next_yolo {
                    "Enable YOLO mode"
                } else {
                    "Disable YOLO mode"
                },
                description: if next_yolo {
                    "Enable YOLO mode? The agent will run shell commands on your machine without asking for approval and without the OS sandbox. Commands get full file and network access, and the server will restart to apply this change."
                        .to_string()
                } else {
                    "Disable YOLO mode? Approval prompts and the OS sandbox will be restored after the server restarts."
                        .to_string()
                },
                confirm_label: if next_yolo { "Enable" } else { "Disable" },
                danger: next_yolo,
            },
            |s| s.settings_ui.workspace_yolo_confirm = None,
            move |s| {
                s.settings_ui.workspace_yolo_confirm = None;
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: confirm_ws_id.clone(),
                    defaults: json!({ "yolo": next_yolo }),
                }));
            },
            k,
            &mut overlays,
        );
    }

    let ws_id_share = ws_id.clone();
    confirm_dialog(
        ConfirmDialogSpec {
            key: "behavior-share-settings-confirm",
            open: s.settings_ui.workspace_share_confirm_open,
            title: "Share settings everywhere",
            description: "All folders and chats will be synced to the current settings. This will overwrite provider, model, and behavior settings on other folders and chats.".to_string(),
            confirm_label: "Share settings",
            danger: true,
        },
        |s| s.settings_ui.workspace_share_confirm_open = false,
        move |s| {
            s.settings_ui.workspace_share_confirm_open = false;
            update_desktop_settings(s, |next| {
                next.per_workspace_settings = false;
            });
            sync_workspace_defaults_everywhere(s, &ws_id_share);
        },
        k,
        &mut overlays,
    );

    if let Some(remove_id) = s.settings_ui.workspace_remove_confirm_id.clone() {
        let remove_name = s
            .workspaces
            .iter()
            .find(|w| w.id == remove_id)
            .map(|w| {
                if w.name.trim().is_empty() {
                    w.path.clone()
                } else {
                    w.name.clone()
                }
            })
            .unwrap_or_else(|| remove_id.clone());
        confirm_dialog(
            ConfirmDialogSpec {
                key: "behavior-remove-ws-confirm",
                open: true,
                title: "Remove from Cowork",
                description: format!(
                    "Remove \"{remove_name}\" from Cowork? Files on disk will not be affected."
                ),
                confirm_label: "Remove",
                danger: true,
            },
            |s| s.settings_ui.workspace_remove_confirm_id = None,
            move |s| {
                s.settings_ui.workspace_remove_confirm_id = None;
                s.dispatch(Action::Native(NativeAction::RemoveWorkspace(
                    remove_id.clone(),
                )));
            },
            k,
            &mut overlays,
        );
    }

    let mut content = PageContent::simple(settings_page(sections)).with_overlays(overlays);
    if workspace_lifecycle_enabled {
        content = content.with_header_actions(vec![
            Button::new("Add folder")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Small)
                .icon(&icons::PLUS)
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Native(NativeAction::PickWorkspaceFolder));
                })
                .build(k),
        ]);
    }
    content
}

/// Builds the `Defaults` (Provider, Default model, Subagent model routing)
/// section appended at the bottom of the `Models` page (`WorkspacesPage`
/// `surface="models"` parity).
pub fn models_defaults_sections(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) -> Vec<El> {
    let Some(ws) = active_behavior_workspace(s) else {
        return Vec::new();
    };
    let ws_id = ws.id.clone();
    let statuses = s
        .workspace_runtime_by_id
        .get(&ws_id)
        .map(|rt| rt.provider_statuses.as_slice())
        .unwrap_or(&[]);

    let configured = sort_and_filter_providers(&s.provider_catalog, statuses, "")
        .into_iter()
        .filter(|p| {
            let status = statuses.iter().find(|st| st.provider == p.id);
            is_provider_connected(p, status, Some(ws))
        })
        .collect::<Vec<_>>();

    if configured.is_empty() {
        return vec![
            Section::new()
                .title("Defaults")
                .description("The provider and model Cowork uses for new chats.")
                .child(
                    SettingsRow::new("No configured providers")
                        .description(
                            "Set up a provider first. Only verified or authorized providers appear in this list.",
                        )
                        .build(k, t),
                )
                .build(k, t),
        ];
    }

    let current_provider_id = ws
        .default_provider
        .as_deref()
        .filter(|id| configured.iter().any(|p| p.id == *id))
        .map(str::to_string)
        .unwrap_or_else(|| configured[0].id.clone());

    let active_provider_entry = configured
        .iter()
        .find(|p| p.id == current_provider_id)
        .copied()
        .unwrap_or(configured[0]);

    let provider_models: Vec<String> = active_provider_entry
        .models
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.id.clone())
        .collect();
    let default_model = ws
        .default_model
        .as_deref()
        .filter(|m| !m.trim().is_empty())
        .or_else(|| {
            s.default_model_by_provider
                .get(&current_provider_id)
                .map(String::as_str)
        })
        .or_else(|| provider_models.first().map(String::as_str))
        .unwrap_or("")
        .to_string();

    let routing_mode = ws
        .default_child_model_routing_mode
        .as_deref()
        .filter(|m| *m == "cross-provider-allowlist")
        .unwrap_or("same-provider")
        .to_string();

    let provider_labels: Vec<String> = configured.iter().map(|p| p.name.clone()).collect();
    let provider_label_refs: Vec<&str> = provider_labels.iter().map(String::as_str).collect();
    let provider_pairs: Vec<(String, String, Option<String>)> = configured
        .iter()
        .map(|p| {
            let first_model = p
                .models
                .iter()
                .find(|m| m.enabled)
                .map(|m| m.id.clone())
                .or_else(|| s.default_model_by_provider.get(&p.id).cloned());
            (p.name.clone(), p.id.clone(), first_model)
        })
        .collect();

    let prov_open = s.settings_ui.open_select_key.as_deref() == Some("models-default-provider");
    let ws_prov = ws_id.clone();
    let rm_prov = routing_mode.clone();
    let prov_select = Select::new("models-default-provider", &provider_label_refs)
        .label("Default chat provider")
        .appearance(SelectAppearance::Field)
        .width(240.0)
        .current(Some(active_provider_entry.name.as_str()))
        .open(prov_open)
        .on_toggle(|s: &mut AppState| {
            let open = s.settings_ui.open_select_key.as_deref() == Some("models-default-provider");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("models-default-provider".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("models-default-provider") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            if let Some((_, pid, first_m)) = provider_pairs.iter().find(|(lbl, _, _)| lbl == chosen)
            {
                let next_default = s
                    .default_model_by_provider
                    .get(pid)
                    .cloned()
                    .filter(|m| !m.trim().is_empty())
                    .or_else(|| first_m.clone())
                    .unwrap_or_default();
                let mut patch = serde_json::Map::new();
                patch.insert("defaultProvider".to_string(), Value::String(pid.clone()));
                if !next_default.is_empty() {
                    patch.insert(
                        "defaultModel".to_string(),
                        Value::String(next_default.clone()),
                    );
                    patch.insert(
                        "defaultPreferredChildModel".to_string(),
                        Value::String(next_default.clone()),
                    );
                    if rm_prov == "same-provider" {
                        patch.insert(
                            "defaultPreferredChildModelRef".to_string(),
                            Value::String(format!("{pid}:{next_default}")),
                        );
                    }
                }
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_prov.clone(),
                    defaults: Value::Object(patch),
                }));
            }
        })
        .build(k, overlays);

    let mut model_opts = provider_models.clone();
    if !default_model.is_empty() && !model_opts.iter().any(|m| m == &default_model) {
        model_opts.insert(0, default_model.clone());
    }
    let model_refs: Vec<&str> = model_opts.iter().map(String::as_str).collect();
    let mod_open = s.settings_ui.open_select_key.as_deref() == Some("models-default-model");
    let ws_mod = ws_id.clone();
    let pid_mod = current_provider_id.clone();
    let rm_mod = routing_mode.clone();
    let child_m = ws
        .default_preferred_child_model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_model.clone());
    let model_select = Select::new("models-default-model", &model_refs)
        .label("Default chat model")
        .appearance(SelectAppearance::Field)
        .width(240.0)
        .current((!default_model.is_empty()).then_some(default_model.as_str()))
        .disabled(model_opts.is_empty())
        .open(mod_open)
        .on_toggle(|s: &mut AppState| {
            let open = s.settings_ui.open_select_key.as_deref() == Some("models-default-model");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("models-default-model".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("models-default-model") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            let next_child = if child_m.is_empty() {
                chosen.to_string()
            } else {
                child_m.clone()
            };
            let mut patch = serde_json::Map::new();
            if !pid_mod.trim().is_empty() {
                patch.insert(
                    "defaultProvider".to_string(),
                    Value::String(pid_mod.clone()),
                );
            }
            patch.insert(
                "defaultModel".to_string(),
                Value::String(chosen.to_string()),
            );
            if rm_mod == "same-provider" {
                patch.insert(
                    "defaultPreferredChildModel".to_string(),
                    Value::String(next_child.clone()),
                );
                if !pid_mod.trim().is_empty() {
                    patch.insert(
                        "defaultPreferredChildModelRef".to_string(),
                        Value::String(format!("{pid_mod}:{next_child}")),
                    );
                }
            }
            let defaults = Value::Object(patch);
            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                workspace_id: ws_mod.clone(),
                defaults,
            }));
        })
        .build(k, overlays);

    let primary_row = row()
        .w_full()
        .flex_wrap()
        .gap(16.0)
        .px(16.0)
        .py(14.0)
        .child(
            col()
                .grow(1.0)
                .min_w(220.0)
                .gap(6.0)
                .child(text("Provider").font(k.ty.ui_medium).color(t.text_base))
                .child(prov_select),
        )
        .child(
            col()
                .grow(1.0)
                .min_w(220.0)
                .gap(6.0)
                .child(
                    text("Default model")
                        .font(k.ty.ui_medium)
                        .color(t.text_base),
                )
                .child(model_select),
        );

    let source_labels = ["Same provider as chat", "Any connected provider"];
    let current_source_label = if routing_mode == "cross-provider-allowlist" {
        "Any connected provider"
    } else {
        "Same provider as chat"
    };
    let src_open = s.settings_ui.open_select_key.as_deref() == Some("models-subagent-source");
    let ws_src = ws_id.clone();
    let pid_src = current_provider_id.clone();
    let fallback_child = ws
        .default_preferred_child_model
        .clone()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| default_model.clone());

    let source_select = Select::new("models-subagent-source", &source_labels)
        .label("Subagent model source")
        .appearance(SelectAppearance::Field)
        .width(240.0)
        .current(Some(current_source_label))
        .open(src_open)
        .on_toggle(|s: &mut AppState| {
            let open = s.settings_ui.open_select_key.as_deref() == Some("models-subagent-source");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("models-subagent-source".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("models-subagent-source") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(move |s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            let next_mode = if chosen == "Any connected provider" {
                "cross-provider-allowlist"
            } else {
                "same-provider"
            };
            let defaults = if next_mode == "same-provider" && !fallback_child.is_empty() {
                json!({
                    "defaultChildModelRoutingMode": next_mode,
                    "defaultPreferredChildModel": fallback_child,
                    "defaultPreferredChildModelRef": format!("{pid_src}:{fallback_child}"),
                })
            } else {
                json!({ "defaultChildModelRoutingMode": next_mode })
            };
            s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                workspace_id: ws_src.clone(),
                defaults,
            }));
        })
        .build(k, overlays);

    let subagent_secondary: El = if routing_mode == "same-provider" {
        let cur_child = ws
            .default_preferred_child_model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| default_model.clone());
        let child_open =
            s.settings_ui.open_select_key.as_deref() == Some("models-subagent-preferred");
        let ws_ch = ws_id.clone();
        let pid_ch = current_provider_id;
        let child_select = Select::new("models-subagent-preferred", &model_refs)
            .label("Preferred subagent model")
            .appearance(SelectAppearance::Field)
            .width(240.0)
            .current((!cur_child.is_empty()).then_some(cur_child.as_str()))
            .disabled(model_opts.is_empty())
            .open(child_open)
            .on_toggle(|s: &mut AppState| {
                let open =
                    s.settings_ui.open_select_key.as_deref() == Some("models-subagent-preferred");
                s.settings_ui.open_select_key = if open {
                    None
                } else {
                    Some("models-subagent-preferred".to_string())
                };
            })
            .on_close(|s: &mut AppState| {
                if s.settings_ui.open_select_key.as_deref() == Some("models-subagent-preferred") {
                    s.settings_ui.open_select_key = None;
                }
            })
            .on_choose(move |s: &mut AppState, chosen, _tx| {
                s.settings_ui.open_select_key = None;
                s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                    workspace_id: ws_ch.clone(),
                    defaults: json!({
                        "defaultPreferredChildModel": chosen,
                        "defaultPreferredChildModelRef": format!("{pid_ch}:{chosen}"),
                    }),
                }));
            })
            .build(k, overlays);

        col()
            .grow(1.0)
            .min_w(220.0)
            .gap(6.0)
            .child(
                text("Preferred subagent model")
                    .font(k.ty.ui_medium)
                    .color(t.text_base),
            )
            .child(child_select)
    } else {
        let allowed = ws.default_allowed_child_model_refs.clone();
        let checks: Vec<El> = configured
            .iter()
            .flat_map(|prov| {
                prov.models
                    .iter()
                    .filter(|m| m.enabled)
                    .map(move |m| (prov.name.clone(), format!("{}:{}", prov.id, m.id)))
            })
            .map(|(pname, model_ref)| {
                let checked = allowed.iter().any(|r| r == &model_ref);
                let allowed_now = allowed.clone();
                let ws_allow = ws_id.clone();
                let cur_pref = ws
                    .default_preferred_child_model_ref
                    .clone()
                    .unwrap_or_default();
                Checkbox::new(checked)
                    .label(format!("{pname}: {model_ref}"))
                    .on_toggle(move |s: &mut AppState| {
                        let mut next = allowed_now.clone();
                        if checked {
                            next.retain(|r| r != &model_ref);
                        } else if !next.iter().any(|r| r == &model_ref) {
                            next.push(model_ref.clone());
                        }
                        let next_pref = if next.iter().any(|r| r == &cur_pref) {
                            cur_pref.clone()
                        } else {
                            next.first().cloned().unwrap_or_default()
                        };
                        s.dispatch(Action::Settings(SettingsAction::UpdateWorkspaceDefaults {
                            workspace_id: ws_allow.clone(),
                            defaults: json!({
                                "defaultAllowedChildModelRefs": next,
                                "defaultPreferredChildModelRef": next_pref,
                            }),
                        }));
                    })
                    .build(k)
            })
            .collect();

        col()
            .grow(1.0)
            .min_w(220.0)
            .gap(6.0)
            .child(
                text("Allowed subagent models")
                    .font(k.ty.ui_medium)
                    .color(t.text_base),
            )
            .child(row().w_full().flex_wrap().gap(8.0).children(checks))
    };

    let subagent_row = col()
        .w_full()
        .px(16.0)
        .py(14.0)
        .gap(12.0)
        .child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .gap(12.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(4.0)
                        .child(text("Subagents").font(k.ty.ui_medium).color(t.text_base))
                        .child(
                            text(
                                "Subagents are helpers Cowork runs alongside your chat to work on tasks in parallel. Choose where their models come from.",
                            )
                            .font(k.ty.small)
                            .color(t.text_muted)
                            .wrap(),
                        ),
                )
                .child(
                    Button::new("Manage profiles")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, tx| {
                            s.dispatch_tx(
                                Action::Navigate(NavAction::OpenSettings(Some(
                                    SettingsPageId::Subagents,
                                ))),
                                tx,
                            );
                        })
                        .build(k),
                ),
        )
        .child(
            row()
                .w_full()
                .flex_wrap()
                .gap(16.0)
                .child(
                    col()
                        .grow(1.0)
                        .min_w(220.0)
                        .gap(6.0)
                        .child(
                            text("Model source")
                                .font(k.ty.ui_medium)
                                .color(t.text_base),
                        )
                        .child(source_select),
                )
                .child(subagent_secondary),
        );

    vec![
        Section::new()
            .title("Defaults")
            .description("The provider and model Cowork uses for new chats.")
            .child(primary_row)
            .child(subagent_row)
            .build(k, t),
    ]
}
