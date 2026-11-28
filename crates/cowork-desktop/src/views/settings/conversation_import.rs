//! Conversation import dialog and its correlated JSON-RPC requests.

use std::collections::{HashMap, HashSet};

use rune::{El, ScrollSpec, col, row, text};
use rune_kit::{Button, ButtonVariant, Checkbox, Dialog, Kit, Menu, MenuItem, TextInput};
use serde::Deserialize;
use serde_json::{Value, json};

use super::primitives::{StatusTone, callout_banner, status_pill};
use crate::actions::{Action, NativeCommand, SettingsAction};
use crate::router::{SettingsPageId, ViewId};
use crate::state::{AppState, WorkspaceRecord};
use crate::theme::ThemeTokens;
use crate::ws::WsRpcError;

pub(crate) const PREVIEW: &str = "cowork/conversationImport/preview";
pub(crate) const IMPORT: &str = "cowork/conversationImport/import";
const SOURCES: &[(&str, &str)] = &[
    ("codex", "Codex"),
    ("claude-code", "Claude Code"),
    ("cowork", "Cowork backup"),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Conversation {
    source: String,
    fingerprint: String,
    title: String,
    cwd: Option<String>,
    mapping: Mapping,
    already_imported_thread_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum Mapping {
    Matched,
    Create,
    Missing,
}

#[derive(Deserialize)]
struct Preview {
    conversations: Vec<Conversation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Imported {
    workspace_id: Option<String>,
    workspace_path: String,
}

#[derive(Deserialize)]
struct Failure {
    fingerprint: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    imported: Vec<Imported>,
    skipped: Vec<Value>,
    failed: Vec<Failure>,
    created_workspaces: Vec<Destination>,
}

#[derive(Default)]
pub(crate) struct ImportDialog {
    workspace_id: String,
    pending: Option<(&'static str, u64)>,
    preview: Option<Preview>,
    selected: HashSet<String>,
    mappings: HashMap<String, String>,
    open_mapping: Option<String>,
    outcome: Option<Outcome>,
    error: Option<String>,
}

impl ImportDialog {
    fn importing(&self) -> bool {
        matches!(self.pending, Some((IMPORT, _)))
    }

    fn ready_to_import(&self, workspaces: &[WorkspaceRecord]) -> bool {
        self.pending.is_none()
            && self.outcome.is_none()
            && !self.selected.is_empty()
            && self.preview.as_ref().is_some_and(|preview| {
                preview.conversations.iter().all(|item| {
                    !self.selected.contains(&item.fingerprint)
                        || !matches!(item.mapping, Mapping::Missing)
                        || self.mappings.get(&item.fingerprint).is_some_and(|id| {
                            workspaces.iter().any(|ws| !ws.archived && ws.id == *id)
                        })
                })
            })
    }
}

pub(crate) fn build_import_source_params(s: &AppState) -> Value {
    let selected = &s.settings_ui.import_selected_sources;
    let path = s.settings_ui.import_path_edit.text.trim();
    if selected.contains("cowork") && !path.is_empty() {
        let sources: Vec<_> = SOURCES
            .iter()
            .filter(|(id, _)| selected.contains(*id))
            .map(|(id, _)| {
                if *id == "cowork" {
                    json!({"source": id, "path": path})
                } else {
                    json!({"source": id})
                }
            })
            .collect();
        json!({"sources": sources})
    } else {
        json!({
            "includeCodex": selected.contains("codex"),
            "includeClaudeCode": selected.contains("claude-code"),
            "includeCowork": selected.contains("cowork"),
        })
    }
}

pub(crate) fn is_current(s: &AppState) -> bool {
    s.route().view == ViewId::Settings
        && s.route().settings_page.canonical() == SettingsPageId::Chats
        && s.settings_ui
            .conversation_import
            .as_ref()
            .is_some_and(|d| Some(d.workspace_id.as_str()) == s.resolve_management_workspace_id())
}

pub(crate) fn open(s: &mut AppState) {
    let Some(id) = s.resolve_management_workspace_id() else {
        return;
    };
    s.settings_ui.conversation_import = Some(ImportDialog {
        workspace_id: id.to_owned(),
        ..Default::default()
    });
    s.dispatch(Action::Settings(SettingsAction::PreviewConversationImport));
}

fn reset_preview(s: &mut AppState) {
    if let Some(dialog) = s.settings_ui.conversation_import.as_mut() {
        *dialog = ImportDialog {
            workspace_id: std::mem::take(&mut dialog.workspace_id),
            ..Default::default()
        };
    }
}

fn close(s: &mut AppState) {
    if !s
        .settings_ui
        .conversation_import
        .as_ref()
        .is_some_and(ImportDialog::importing)
    {
        s.settings_ui.conversation_import = None;
    }
}

pub(crate) fn scan(s: &mut AppState) {
    if !is_current(s) || s.settings_ui.import_selected_sources.is_empty() {
        return;
    }
    let dialog = s.settings_ui.conversation_import.as_ref().unwrap();
    if dialog.importing() {
        return;
    }
    let ws = dialog.workspace_id.clone();
    reset_preview(s);
    let mut params = build_import_source_params(s);
    params["limit"] = json!(250);
    let id = s.send_ws_request(&ws, PREVIEW, params, false);
    s.settings_ui.conversation_import.as_mut().unwrap().pending = Some((PREVIEW, id));
}

pub(crate) fn submit(s: &mut AppState) {
    if !is_current(s) {
        return;
    }
    let dialog = s.settings_ui.conversation_import.as_ref().unwrap();
    if !dialog.ready_to_import(&s.workspaces) {
        return;
    }
    let ws = dialog.workspace_id.clone();
    let mut params = build_import_source_params(s);
    let mut mappings = serde_json::Map::new();
    let selected: Vec<_> = dialog
        .preview
        .as_ref()
        .unwrap()
        .conversations
        .iter()
        .filter(|item| dialog.selected.contains(&item.fingerprint))
        .map(|item| {
            if matches!(item.mapping, Mapping::Missing) {
                mappings.insert(
                    item.fingerprint.clone(),
                    json!({"kind": "fallback", "workspaceId": dialog.mappings[&item.fingerprint]}),
                );
            }
            json!({"source": item.source, "fingerprint": item.fingerprint})
        })
        .collect();
    params["selected"] = json!(selected);
    params["mappings"] = Value::Object(mappings);
    params["mode"] = json!("skip-existing");
    let id = s.send_ws_request(&ws, IMPORT, params, false);
    let dialog = s.settings_ui.conversation_import.as_mut().unwrap();
    dialog.pending = Some((IMPORT, id));
    dialog.open_mapping = None;
    dialog.error = None;
}

pub(crate) fn receive(
    s: &mut AppState,
    workspace_id: &str,
    request_id: u64,
    method: &str,
    response: Result<Value, WsRpcError>,
) {
    let current = is_current(s)
        && s.settings_ui.conversation_import.as_ref().is_some_and(|d| {
            d.workspace_id == workspace_id && d.pending == Some((method, request_id))
        });
    // An import may finish after the user navigates away. Its persisted destinations
    // still need a refresh, even though its dialog has gone away.
    if method == IMPORT {
        let outcome = response.map_err(|e| e.message).and_then(|payload| {
            serde_json::from_value::<Outcome>(payload).map_err(|e| e.to_string())
        });
        if let Ok(ref result) = outcome {
            refresh_destinations(s, result);
        }
        if current {
            let dialog = s.settings_ui.conversation_import.as_mut().unwrap();
            dialog.pending = None;
            match outcome {
                Ok(result) => dialog.outcome = Some(result),
                Err(error) => dialog.error = Some(error),
            }
        }
    } else if current {
        let dialog = s.settings_ui.conversation_import.as_mut().unwrap();
        dialog.pending = None;
        match response.map_err(|e| e.message).and_then(|payload| {
            serde_json::from_value::<Preview>(payload).map_err(|e| e.to_string())
        }) {
            Ok(preview) => {
                dialog.selected = preview
                    .conversations
                    .iter()
                    .filter(|c| c.already_imported_thread_id.is_none())
                    .map(|c| c.fingerprint.clone())
                    .collect();
                dialog.preview = Some(preview);
            }
            Err(error) => dialog.error = Some(error),
        }
    }
}

fn refresh_destinations(s: &mut AppState, result: &Outcome) {
    let mut destinations: HashSet<String> = result
        .created_workspaces
        .iter()
        .map(|w| w.workspace_id.clone())
        .collect();
    for item in &result.imported {
        if let Some(id) = s
            .workspaces
            .iter()
            .find(|w| Some(&w.id) == item.workspace_id.as_ref() || w.path == item.workspace_path)
            .map(|w| &w.id)
            .or(item.workspace_id.as_ref())
        {
            destinations.insert(id.clone());
        }
    }
    // Load missing workspace records from the same persisted registry the server updated.
    // Queue that read before thread/list replies can cause the current client snapshot to save.
    if destinations
        .iter()
        .any(|id| !s.workspaces.iter().any(|w| w.id == *id))
    {
        s.send_native(NativeCommand::LoadImportedWorkspaces(
            destinations.into_iter().collect(),
        ));
    } else {
        for id in destinations {
            refresh_threads(s, &id);
        }
    }
}

pub(crate) fn refresh_threads(s: &mut AppState, id: &str) {
    let Some(ws) = s.workspaces.iter().find(|w| w.id == id && !w.archived) else {
        return;
    };
    if s.is_workspace_ws_connected(id) {
        s.dispatch(Action::Settings(SettingsAction::ListArchivedThreads {
            workspace_id: id.to_owned(),
        }));
    } else {
        // On initialization the workspace automatically requests thread/list.
        s.send_native(NativeCommand::StartWorkspaceServer {
            workspace_id: ws.id.clone(),
            path: ws.path.clone(),
            yolo: ws.yolo,
        });
    }
}

fn mapping_control(
    s: &AppState,
    dialog: &ImportDialog,
    item: &Conversation,
    k: &Kit,
    layer: &mut Vec<El>,
) -> El {
    let fingerprint = item.fingerprint.clone();
    let value = dialog.mappings.get(&fingerprint);
    let label = s
        .workspaces
        .iter()
        .find(|w| !w.archived && value == Some(&w.id))
        .map(|w| w.name.as_str())
        .unwrap_or("Choose workspace…");
    let mut menu = Menu::new(format!("import-destination-{fingerprint}"))
        .open(dialog.open_mapping.as_ref() == Some(&fingerprint))
        .trigger(
            Button::new(label)
                .variant(ButtonVariant::Outline)
                .disabled(dialog.importing())
                .on_press(move |s: &mut AppState| {
                    if let Some(d) = s.settings_ui.conversation_import.as_mut() {
                        d.open_mapping = Some(fingerprint.clone());
                    }
                })
                .build(k)
                .key(format!("import-map-{}", item.fingerprint)),
        )
        .on_close(|s: &mut AppState| {
            if let Some(d) = s.settings_ui.conversation_import.as_mut() {
                d.open_mapping = None;
            }
        });
    for ws in s.workspaces.iter().filter(|ws| !ws.archived) {
        let fingerprint = item.fingerprint.clone();
        let id = ws.id.clone();
        menu = menu.item(
            MenuItem::new(&ws.name)
                .description(&ws.path)
                .checked(value == Some(&id))
                .on_select(move |s: &mut AppState| {
                    if let Some(d) = s.settings_ui.conversation_import.as_mut() {
                        d.mappings.insert(fingerprint.clone(), id.clone());
                        d.open_mapping = None;
                    }
                }),
        );
    }
    menu.build(k, layer)
}

pub(crate) fn render(s: &AppState, k: &Kit, t: &ThemeTokens, overlays: &mut Vec<El>) {
    let Some(d) = s
        .settings_ui
        .conversation_import
        .as_ref()
        .filter(|_| is_current(s))
    else {
        return;
    };
    let importing = d.importing();
    let mut sources = row().w_full().flex_wrap().gap(14.0);
    for &(id, label) in SOURCES {
        sources = sources.child(
            Checkbox::new(s.settings_ui.import_selected_sources.contains(id))
                .label(label)
                .disabled(importing)
                .on_toggle(move |s: &mut AppState| {
                    if !s.settings_ui.import_selected_sources.remove(id) {
                        s.settings_ui.import_selected_sources.insert(id.to_owned());
                    }
                    reset_preview(s);
                })
                .build(k)
                .key(format!("import-source-{id}")),
        );
    }
    let mut controls = col().w_full().gap(8.0).child(sources);
    if s.settings_ui.import_selected_sources.contains("cowork") {
        controls = controls.child(
            TextInput::new(&s.settings_ui.import_path_edit)
                .label("Alternate .cowork folder")
                .placeholder("Optional path to a Cowork backup")
                .width(None)
                .disabled(importing)
                .on_edit(|s: &mut AppState| &mut s.settings_ui.import_path_edit)
                .on_change(|s: &mut AppState, _| reset_preview(s))
                .build(k),
        );
    }
    let mut body = col().w_full().gap(12.0);
    let mut menus = Vec::new();
    if let Some(error) = d.error.as_deref() {
        body = body.child(callout_banner(StatusTone::Danger, error, k, t));
    }
    if let Some(result) = &d.outcome {
        let summary = format!(
            "Imported {}, skipped {}, failed {}.",
            result.imported.len(),
            result.skipped.len(),
            result.failed.len()
        );
        body = body.child(callout_banner(
            if result.failed.is_empty() {
                StatusTone::Success
            } else {
                StatusTone::Warning
            },
            summary,
            k,
            t,
        ));
        for failure in &result.failed {
            let title = d
                .preview
                .as_ref()
                .and_then(|p| {
                    p.conversations
                        .iter()
                        .find(|c| c.fingerprint == failure.fingerprint)
                })
                .map(|c| c.title.as_str())
                .unwrap_or(&failure.fingerprint);
            body = body.child(
                text(format!("{title} — {}", failure.message))
                    .font(k.ty.small)
                    .color(t.text_muted)
                    .wrap(),
            );
        }
    } else if let Some(preview) = &d.preview {
        if preview.conversations.is_empty() {
            body = body.child(
                text("No conversations found.")
                    .font(k.ty.ui)
                    .color(t.text_muted),
            );
        }
        for item in &preview.conversations {
            let fp = item.fingerprint.clone();
            let checked = d.selected.contains(&fp);
            let imported = item.already_imported_thread_id.is_some();
            let source = SOURCES
                .iter()
                .find(|(id, _)| *id == item.source)
                .map(|(_, label)| *label)
                .unwrap_or(&item.source);
            let mut entry = col()
                .key(format!("import-row-{fp}"))
                .w_full()
                .gap(4.0)
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap(8.0)
                        .child(
                            Checkbox::new(checked)
                                .label(&item.title)
                                .description(item.cwd.as_deref().unwrap_or(source))
                                .disabled(imported || importing)
                                .on_toggle(move |s: &mut AppState| {
                                    if let Some(d) = s.settings_ui.conversation_import.as_mut()
                                        && !d.selected.remove(&fp)
                                    {
                                        d.selected.insert(fp.clone());
                                    }
                                })
                                .build(k)
                                .key(format!("import-check-{}", item.fingerprint))
                                .grow(1.0)
                                .min_w(0.0),
                        )
                        .child(status_pill(
                            if imported { "Imported" } else { source },
                            StatusTone::Neutral,
                            k,
                            t,
                        )),
                );
            if checked && matches!(item.mapping, Mapping::Missing) {
                entry = entry.child(
                    row()
                        .items_center()
                        .flex_wrap()
                        .gap(8.0)
                        .child(
                            text("Destination workspace")
                                .font(k.ty.small)
                                .color(t.text_muted),
                        )
                        .child(mapping_control(s, d, item, k, &mut menus)),
                );
            }
            body = body.child(entry);
        }
    } else {
        let message = if d.pending.is_some() {
            "Scanning conversations…"
        } else {
            "Scan the selected sources to preview conversations."
        };
        body = body.child(text(message).font(k.ty.ui).color(t.text_muted));
    }
    let mut actions = row().gap(8.0).child(
        Button::new("Close")
            .variant(ButtonVariant::Ghost)
            .disabled(importing)
            .on_press(close)
            .build(k),
    );
    if d.outcome.is_none() {
        let label = if importing {
            "Importing…".to_string()
        } else {
            format!("Import selected ({})", d.selected.len())
        };
        actions = actions.child(
            Button::new(label)
                .variant(ButtonVariant::Submit)
                .disabled(!d.ready_to_import(&s.workspaces))
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::ExecuteConversationImport))
                })
                .build(k)
                .key("conversation-import-submit"),
        );
    }
    let footer = row()
        .w_full()
        .justify_between()
        .gap(8.0)
        .child(
            Button::new("Scan & preview")
                .variant(ButtonVariant::Outline)
                .disabled(s.settings_ui.import_selected_sources.is_empty() || d.pending.is_some())
                .on_press(|s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::PreviewConversationImport))
                })
                .build(k),
        )
        .child(actions);
    Dialog::new("conversation-import", "Import conversations")
        .open(true)
        .width(600.0)
        .fit()
        .on_close(close)
        .child(
            col()
                .w_full()
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(controls)
                .child(
                    k.scroll_bar(
                        col()
                            .w_full()
                            .max_h(320.0)
                            .scroll(ScrollSpec {
                                stick_bottom: false,
                            })
                            .child(body),
                    ),
                )
                .child(footer),
        )
        .build(k, overlays);
    overlays.extend(menus);
}
