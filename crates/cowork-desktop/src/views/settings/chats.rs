//! Chats & Archived Conversations page + Conversation Import dialog
//! (`apps/desktop/src/ui/settings/pages/ArchivedChatsPage.tsx`, `import/ConversationImportDialog.tsx`).

use rune::{El, col, row, text};
use rune_kit::{
    Button, ButtonVariant, Checkbox, ControlSize, Dialog, Kit, Select, SelectAppearance, TextInput,
};
use serde_json::{Map, Value, json};

use crate::actions::{Action, ChatAction, SettingsAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, Section, SettingsRow, StatusTone, callout_banner,
    confirm_dialog, format_timestamp_friendly, management_targets, search_input, settings_page,
    status_pill, update_desktop_settings,
};
use crate::views::settings::shell::PageContent;

const RETENTION_OPTIONS: &[(u32, &str)] = &[
    (0, "Never auto-delete"),
    (7, "After 7 days"),
    (30, "After 30 days"),
    (90, "After 90 days"),
];

const IMPORT_SOURCE_OPTIONS: &[(&str, &str)] = &[
    ("codex", "Codex"),
    ("claude-code", "Claude Code"),
    ("cowork", "Cowork backup / .cowork folder"),
];

fn retention_label_for_days(days: u32) -> String {
    RETENTION_OPTIONS
        .iter()
        .find(|(d, _)| *d == days)
        .map(|(_, lbl)| (*lbl).to_string())
        .unwrap_or_else(|| format!("After {days} days"))
}

fn days_for_retention_label(label: &str) -> u32 {
    RETENTION_OPTIONS
        .iter()
        .find(|(_, lbl)| *lbl == label)
        .map(|(d, _)| *d)
        .unwrap_or(30)
}

/// Builds JSON-RPC source selection parameters conforming to `ConversationImportPreviewParams`
/// and `ConversationImportRunParams` (`sources` objects with optional `path`, or `include*` flags).
pub fn build_import_source_params(s: &AppState) -> Value {
    let selected = &s.settings_ui.import_selected_sources;
    let cowork_path = s.settings_ui.import_path_edit.text.trim();
    let include_codex = selected.contains("codex");
    let include_claude_code = selected.contains("claude-code");
    let include_cowork = selected.contains("cowork");

    let mut obj = Map::new();
    if include_cowork && !cowork_path.is_empty() {
        let mut requests = Vec::new();
        for (source_id, _) in IMPORT_SOURCE_OPTIONS {
            if !selected.contains(*source_id) {
                continue;
            }
            let mut req = Map::new();
            req.insert("source".to_string(), json!(source_id));
            if *source_id == "cowork" {
                req.insert("path".to_string(), json!(cowork_path));
            }
            requests.push(Value::Object(req));
        }
        obj.insert("sources".to_string(), Value::Array(requests));
    } else {
        obj.insert("includeCodex".to_string(), json!(include_codex));
        obj.insert("includeClaudeCode".to_string(), json!(include_claude_code));
        obj.insert("includeCowork".to_string(), json!(include_cowork));
    }
    Value::Object(obj)
}

fn build_import_dialog(
    s: &AppState,
    active_ws_id: Option<&str>,
    k: &Kit,
    t: &ThemeTokens,
    overlays: &mut Vec<El>,
) {
    let selected = &s.settings_ui.import_selected_sources;
    let mut source_checks = col().w_full().gap(8.0);
    for (id, label) in IMPORT_SOURCE_OPTIONS {
        let key = (*id).to_string();
        let checked = selected.contains(*id);
        source_checks = source_checks.child(
            Checkbox::new(checked)
                .label(*label)
                .on_toggle(move |s: &mut AppState| {
                    if s.settings_ui.import_selected_sources.contains(&key) {
                        s.settings_ui.import_selected_sources.remove(&key);
                    } else {
                        s.settings_ui.import_selected_sources.insert(key.clone());
                    }
                })
                .build(k),
        );
    }

    let path_field = TextInput::new(&s.settings_ui.import_path_edit)
        .label("Optional alternate .cowork folder path")
        .placeholder("/path/to/backup/.cowork")
        .width(None)
        .on_edit(|s: &mut AppState| &mut s.settings_ui.import_path_edit)
        .build(k);

    let preview_items: Vec<&Value> = s
        .conversation_import_preview
        .as_ref()
        .and_then(|v| {
            v.get("conversations")
                .or_else(|| v.get("event").and_then(|e| e.get("conversations")))
        })
        .and_then(Value::as_array)
        .map(|arr| arr.iter().collect())
        .unwrap_or_default();

    let importable_selected: Vec<Value> = preview_items
        .iter()
        .filter(|c| c.get("alreadyImportedThreadId").is_none_or(Value::is_null))
        .filter_map(|c| {
            let source = c.get("source")?.as_str()?;
            let fingerprint = c.get("fingerprint")?.as_str()?;
            Some(json!({ "source": source, "fingerprint": fingerprint }))
        })
        .collect();

    let preview_summary = if preview_items.is_empty() {
        text("Choose one or more conversation sources above and click Scan & preview.")
            .font(k.ty.small)
            .color(t.text_muted)
            .wrap()
    } else {
        let mut list = col().w_full().gap(6.0);
        list = list.child(
            text(format!(
                "Found {} conversations ({} ready to import).",
                preview_items.len(),
                importable_selected.len()
            ))
            .font(k.ty.ui_medium)
            .color(t.text_base),
        );
        for item in preview_items.iter().take(6) {
            let title = item
                .get("title")
                .and_then(Value::as_str)
                .filter(|v| !v.trim().is_empty())
                .unwrap_or("Untitled conversation");
            let source = item
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let already = item
                .get("alreadyImportedThreadId")
                .is_some_and(|v| !v.is_null());
            list = list.child(
                row()
                    .w_full()
                    .justify_between()
                    .items_center()
                    .gap(8.0)
                    .px(10.0)
                    .py(6.0)
                    .radius(k.radius.md)
                    .fill(t.panel_bg)
                    .border(1.0, t.border_muted)
                    .child(text(title).font(k.ty.ui).color(t.text_base).wrap())
                    .child(status_pill(
                        if already { "Imported" } else { source },
                        if already {
                            StatusTone::Neutral
                        } else {
                            StatusTone::Success
                        },
                        k,
                        t,
                    )),
            );
        }
        list
    };

    let ws_for_scan = active_ws_id.map(str::to_owned);
    let ws_for_import = active_ws_id.map(str::to_owned);
    let scan_disabled = ws_for_scan.is_none() || s.settings_ui.import_selected_sources.is_empty();
    let import_disabled = ws_for_import.is_none() || importable_selected.is_empty();

    let footer = row()
        .w_full()
        .justify_between()
        .items_center()
        .gap(8.0)
        .pt(6.0)
        .child(
            Button::new("Scan & preview")
                .variant(ButtonVariant::Outline)
                .control_size(ControlSize::Regular)
                .disabled(scan_disabled)
                .on_press(move |s: &mut AppState| {
                    if let Some(ws_id) = &ws_for_scan {
                        let mut params = build_import_source_params(s);
                        if let Some(obj) = params.as_object_mut() {
                            obj.insert("limit".to_string(), json!(250));
                        }
                        s.dispatch(Action::Settings(
                            SettingsAction::PreviewConversationImport {
                                workspace_id: ws_id.clone(),
                                params,
                            },
                        ));
                    }
                })
                .build(k),
        )
        .child(
            row()
                .gap(8.0)
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Regular)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.import_dialog_open = false;
                        })
                        .build(k),
                )
                .child(
                    Button::new(format!("Import ({})", importable_selected.len()))
                        .variant(ButtonVariant::Contrast)
                        .control_size(ControlSize::Regular)
                        .disabled(import_disabled)
                        .on_press(move |s: &mut AppState| {
                            if let Some(ws_id) = &ws_for_import {
                                let mut params = build_import_source_params(s);
                                if let Some(obj) = params.as_object_mut() {
                                    obj.insert(
                                        "selected".to_string(),
                                        Value::Array(importable_selected.clone()),
                                    );
                                    obj.insert("mappings".to_string(), json!({}));
                                    obj.insert("mode".to_string(), json!("skip-existing"));
                                }
                                s.settings_ui.import_dialog_open = false;
                                s.dispatch(Action::Settings(
                                    SettingsAction::ExecuteConversationImport {
                                        workspace_id: ws_id.clone(),
                                        params,
                                    },
                                ));
                            }
                        })
                        .build(k),
                ),
        );

    Dialog::new("conversation-import-dialog", "Import conversations")
        .open(s.settings_ui.import_dialog_open)
        .width(520.0)
        .fit()
        .on_close(|s: &mut AppState| {
            s.settings_ui.import_dialog_open = false;
        })
        .child(
            col()
                .w_full()
                .min_w(0.0)
                .px(16.0)
                .pb(16.0)
                .gap(12.0)
                .child(
                    text("Bring existing transcripts from Codex, Claude Code, or another Cowork backup into this workspace.")
                        .font(k.ty.ui)
                        .color(t.text_muted)
                        .wrap(),
                )
                .child(source_checks)
                .child(path_field)
                .child(preview_summary)
                .child(footer),
        )
        .build(k, overlays);
}

/// Renders the Chats (Archived Conversations & Import) settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let targets = management_targets(s);
    let active_ws_id = s
        .resolve_management_workspace_id()
        .or_else(|| targets.first().map(|entry| entry.id.as_str()));

    let mut overlays = Vec::new();
    let mut blocks: Vec<El> = Vec::new();

    if let Some(err) = s.settings_mutation_error.as_deref() {
        blocks.push(callout_banner(StatusTone::Danger, err, k, t));
    }

    // 1. Conversation import section
    let import_section = Section::new()
        .title("Import conversations")
        .description("Import transcripts from Codex, Claude Code, or Cowork backups.")
        .child(
            SettingsRow::new("Conversation importer")
                .description("Scan local archives, review matching conversations, and skip already-imported threads.")
                .control(
                    Button::new("Import conversations…")
                        .variant(ButtonVariant::Outline)
                        .control_size(ControlSize::Regular)
                        .on_press(|s: &mut AppState| {
                            s.settings_ui.import_dialog_open = true;
                        })
                        .build(k),
                )
                .build(k, t),
        )
        .build(k, t);
    blocks.push(import_section);

    // 2. Retention policy section
    let retention_days = s.desktop_settings.archived_chats_auto_delete_days;
    let retention_labels: Vec<&str> = RETENTION_OPTIONS.iter().map(|(_, lbl)| *lbl).collect();
    let current_retention = retention_label_for_days(retention_days);
    let select_open = s.settings_ui.open_select_key.as_deref() == Some("chats-retention-select");

    let retention_select = Select::new("chats-retention-select", &retention_labels)
        .label("Auto-delete archived chats")
        .appearance(SelectAppearance::Field)
        .width(210.0)
        .current(Some(current_retention.as_str()))
        .open(select_open)
        .on_toggle(|s: &mut AppState| {
            let open = s.settings_ui.open_select_key.as_deref() == Some("chats-retention-select");
            s.settings_ui.open_select_key = if open {
                None
            } else {
                Some("chats-retention-select".to_string())
            };
        })
        .on_close(|s: &mut AppState| {
            if s.settings_ui.open_select_key.as_deref() == Some("chats-retention-select") {
                s.settings_ui.open_select_key = None;
            }
        })
        .on_choose(|s: &mut AppState, chosen, _tx| {
            s.settings_ui.open_select_key = None;
            let days = days_for_retention_label(chosen);
            update_desktop_settings(s, |next| {
                next.archived_chats_auto_delete_days = days;
            });
        })
        .build(k, &mut overlays);

    let retention_section = Section::new()
        .title("Retention")
        .description("Automatically clean up archived chats after a chosen period.")
        .child(
            SettingsRow::new("Auto-delete archived chats")
                .description(
                    "Applies locally across archived threads older than the selected threshold.",
                )
                .control(retention_select)
                .build(k, t),
        )
        .build(k, t);
    blocks.push(retention_section);

    // 3. Archived chats list section
    let query = s
        .settings_ui
        .chats_search_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let ws_filter = s.settings_ui.chats_workspace_filter.as_deref();

    let mut filtered: Vec<_> = s
        .archived_threads
        .iter()
        .filter(|thread| {
            if let Some(ws) = ws_filter
                && thread.workspace_id != ws
            {
                return false;
            }
            if query.is_empty() {
                return true;
            }
            thread.title.to_ascii_lowercase().contains(&query)
                || thread.id.to_ascii_lowercase().contains(&query)
        })
        .collect();
    filtered.sort_by_key(|b| std::cmp::Reverse(b.archived_at));

    let refresh_ws = active_ws_id.map(str::to_owned);
    let mut header_actions = Vec::new();
    if let Some(ws_id) = refresh_ws {
        header_actions.push(
            Button::new("Refresh archived")
                .variant(ButtonVariant::Outline)
                .icon(&icons::REFRESH_CCW)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::ListArchivedThreads {
                        workspace_id: ws_id.clone(),
                    }));
                })
                .build(k),
        );
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
            &s.settings_ui.chats_search_edit,
            "Filter archived chats",
            "Search archived titles...",
            Some(320.0),
            |s: &mut AppState| &mut s.settings_ui.chats_search_edit,
            |s: &mut AppState, _tx| {
                s.settings_ui.chats_search_edit = rune::TextEdit::new("");
            },
            k,
        ))
        .child(status_pill(
            format!("{} archived", filtered.len()),
            StatusTone::Neutral,
            k,
            t,
        ));

    let mut archived_section = Section::new()
        .title("Archived chats")
        .description("Restore conversations back to the sidebar or permanently remove them.")
        .child(search_bar);

    if filtered.is_empty() {
        archived_section = archived_section.child(
            EmptyState::new(if query.is_empty() {
                "No archived chats"
            } else {
                "No matching archived chats"
            })
            .icon(&icons::ARCHIVE_RESTORE)
            .description(if query.is_empty() {
                "Archive threads from the chat list to store them cleanly here."
            } else {
                "Try a different search query or clear the workspace filter."
            })
            .build(k, t),
        );
    } else {
        for thread in filtered {
            let ws_name = s
                .workspaces
                .iter()
                .find(|w| w.id == thread.workspace_id)
                .map(|w| {
                    if w.one_off_chat {
                        "Chats".to_string()
                    } else if w.name.trim().is_empty() {
                        w.path.clone()
                    } else {
                        w.name.clone()
                    }
                })
                .unwrap_or_else(|| thread.workspace_id.clone());

            let title = if thread.title.trim().is_empty() {
                "Untitled chat"
            } else {
                thread.title.trim()
            };
            let restore_id = thread.id.clone();
            let delete_id = thread.id.clone();

            archived_section = archived_section.child(
                SettingsRow::new(title)
                    .description(format!(
                        "{ws_name} · Archived {}",
                        format_timestamp_friendly(thread.archived_at)
                    ))
                    .control(
                        row()
                            .items_center()
                            .gap(8.0)
                            .child(
                                Button::new("Restore")
                                    .variant(ButtonVariant::Outline)
                                    .icon(&icons::REFRESH_CCW)
                                    .control_size(ControlSize::Small)
                                    .on_press(move |s: &mut AppState| {
                                        s.dispatch(Action::Chat(ChatAction::RestoreThread(
                                            restore_id.clone(),
                                        )));
                                    })
                                    .build(k),
                            )
                            .child(
                                Button::new("Delete")
                                    .variant(ButtonVariant::Outline)
                                    .icon(&icons::TRASH)
                                    .control_size(ControlSize::Small)
                                    .on_press(move |s: &mut AppState| {
                                        s.settings_ui.chats_confirm_delete_id =
                                            Some(delete_id.clone());
                                    })
                                    .build(k),
                            ),
                    )
                    .build(k, t),
            );
        }
    }
    blocks.push(archived_section.build(k, t));

    build_import_dialog(s, active_ws_id, k, t, &mut overlays);

    let confirm_delete_id = s.settings_ui.chats_confirm_delete_id.clone();
    let delete_title = confirm_delete_id
        .as_deref()
        .and_then(|id| s.archived_threads.iter().find(|t| t.id == id))
        .map(|t| t.title.as_str())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("this archived chat")
        .to_string();

    confirm_dialog(
        ConfirmDialogSpec {
            key: "chats-confirm-delete-dialog",
            open: confirm_delete_id.is_some(),
            title: "Delete archived chat permanently?",
            description: format!(
                "Permanently deletes \"{delete_title}\" and its transcript from this workspace. This cannot be undone."
            ),
            confirm_label: "Delete chat",
            danger: true,
        },
        |s| {
            s.settings_ui.chats_confirm_delete_id = None;
        },
        |s| {
            if let Some(thread_id) = s.settings_ui.chats_confirm_delete_id.take() {
                s.dispatch(Action::Chat(ChatAction::DeleteThread(thread_id)));
            }
        },
        k,
        &mut overlays,
    );

    PageContent::simple(settings_page(blocks))
        .with_header_actions(header_actions)
        .with_overlays(overlays)
}
