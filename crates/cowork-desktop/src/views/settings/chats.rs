//! Chats & Archived Conversations page + Conversation Import dialog
//! (`apps/desktop/src/ui/settings/pages/ArchivedChatsPage.tsx`, `import/ConversationImportDialog.tsx`).

use rune::{El, row};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit, Select, SelectAppearance};

use crate::actions::{Action, ChatAction, SettingsAction};
use crate::state::AppState;
use crate::theme::ThemeTokens;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, Section, SettingsRow, StatusTone, callout_banner,
    confirm_dialog, format_timestamp_friendly, search_input, settings_page, status_pill,
    update_desktop_settings,
};
use crate::views::settings::shell::PageContent;
use crate::views::settings::{conversation_import, icons};

const RETENTION_OPTIONS: &[(u32, &str)] = &[
    (0, "Never auto-delete"),
    (7, "After 7 days"),
    (30, "After 30 days"),
    (90, "After 90 days"),
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

/// Renders the Chats (Archived Conversations & Import) settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let active_ws_id = s.resolve_management_workspace_id();

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
                        .disabled(active_ws_id.is_none())
                        .on_press(conversation_import::open)
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

    conversation_import::render(s, k, t, &mut overlays);

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
