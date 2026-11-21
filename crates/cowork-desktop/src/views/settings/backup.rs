//! Backups & Checkpoints settings page (`apps/desktop/src/ui/settings/pages/BackupPage.tsx`).

use rune::{El, TextEdit, col, el, icon, row, text};
use rune_kit::{Button, ButtonVariant, ControlSize, Kit};
use serde_json::json;

use crate::actions::{Action, SettingsAction};
use crate::state::{AppState, BackupCheckpointSummary, BackupSummary};
use crate::theme::ThemeTokens;
use crate::views::settings::icons;
use crate::views::settings::primitives::{
    ConfirmDialogSpec, EmptyState, Section, SettingsRow, StatusTone, confirm_dialog,
    format_byte_size, format_timestamp_friendly, management_targets, mini_switch, search_input,
    settings_page, stat_tile, status_pill,
};
use crate::views::settings::shell::PageContent;

#[derive(Clone, Debug)]
struct BackupRowItem {
    selection_id: String,
    session_id: String,
    checkpoint_id: Option<String>,
    checkpoint_index: usize,
    label: String,
    session_title: String,
    trigger: Option<String>,
    created_at: i64,
    size_bytes: u64,
}

fn split_backup_id(backup_id: &str) -> (&str, Option<&str>) {
    match backup_id.split_once("::") {
        Some((session_id, checkpoint_id)) => (session_id, Some(checkpoint_id)),
        None => (backup_id, None),
    }
}

fn parse_iso_timestamp_ms(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn checkpoint_row(
    session_id: &str,
    session_title: &str,
    fallback_created_at: i64,
    cp: &BackupCheckpointSummary,
) -> BackupRowItem {
    let cp_label = if cp.index > 0 {
        format!("{session_title} · Checkpoint #{}", cp.index)
    } else {
        format!("{session_title} · {}", cp.id)
    };
    let trigger = (!cp.trigger.trim().is_empty()).then(|| cp.trigger.trim().to_string());
    BackupRowItem {
        selection_id: format!("{session_id}::{}", cp.id),
        session_id: session_id.to_string(),
        checkpoint_id: Some(cp.id.clone()),
        checkpoint_index: cp.index,
        label: cp_label,
        session_title: session_title.to_string(),
        trigger,
        created_at: parse_iso_timestamp_ms(&cp.created_at).unwrap_or(fallback_created_at),
        size_bytes: cp.patch_bytes,
    }
}

fn collect_backup_rows(backups: &[BackupSummary]) -> Vec<BackupRowItem> {
    let mut rows = Vec::new();
    for entry in backups {
        let session_id = if entry.target_session_id.trim().is_empty() {
            split_backup_id(&entry.id).0
        } else {
            entry.target_session_id.as_str()
        };
        let session_title = entry
            .title
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let lbl = entry.label.trim();
                (!lbl.is_empty()).then_some(lbl)
            })
            .unwrap_or(session_id);

        if entry.checkpoints.is_empty() {
            let (_, cp_opt) = split_backup_id(&entry.id);
            rows.push(BackupRowItem {
                selection_id: entry.id.clone(),
                session_id: session_id.to_string(),
                checkpoint_id: cp_opt.map(str::to_string),
                checkpoint_index: 0,
                label: session_title.to_string(),
                session_title: session_title.to_string(),
                trigger: None,
                created_at: entry.created_at,
                size_bytes: entry.original_snapshot_bytes.unwrap_or(entry.size_bytes),
            });
        } else {
            for cp in &entry.checkpoints {
                rows.push(checkpoint_row(
                    session_id,
                    session_title,
                    entry.created_at,
                    cp,
                ));
            }
            rows.push(BackupRowItem {
                selection_id: session_id.to_string(),
                session_id: session_id.to_string(),
                checkpoint_id: None,
                checkpoint_index: 0,
                label: format!("{session_title} · Original snapshot"),
                session_title: session_title.to_string(),
                trigger: Some("original".to_string()),
                created_at: entry.created_at,
                size_bytes: entry.original_snapshot_bytes.unwrap_or(entry.size_bytes),
            });
        }
    }
    rows.sort_by_key(|row| {
        std::cmp::Reverse((
            row.created_at,
            row.checkpoint_id.is_some(),
            row.checkpoint_index,
        ))
    });
    rows
}

fn backup_list_item(entry: &BackupRowItem, selected: bool, k: &Kit, t: &ThemeTokens) -> El {
    let id_for_press = entry.selection_id.clone();
    let label = if entry.label.trim().is_empty() {
        entry.selection_id.as_str()
    } else {
        entry.label.trim()
    };

    let mut meta_row = row().w_full().justify_between().items_center().gap(6.0);
    meta_row = meta_row.child(
        text(format_timestamp_friendly(entry.created_at))
            .font(k.ty.small)
            .color(t.text_muted),
    );
    if let Some(trigger) = &entry.trigger {
        meta_row = meta_row.child(status_pill(
            trigger.clone(),
            if entry.checkpoint_id.is_some() {
                StatusTone::Success
            } else {
                StatusTone::Neutral
            },
            k,
            t,
        ));
    }

    col()
        .key(format!("backup-item-{}", entry.selection_id))
        .w_full()
        .px(12.0)
        .py(10.0)
        .gap(4.0)
        .radius(k.radius.lg)
        .fill(if selected { t.accent_soft } else { t.panel_bg })
        .border(1.0, if selected { t.accent } else { t.border_muted })
        .on_press(move |s: &mut AppState| {
            s.settings_ui.backup_selected_id = Some(id_for_press.clone());
        })
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .gap(8.0)
                .child(
                    row()
                        .items_center()
                        .gap(6.0)
                        .grow(1.0)
                        .min_w(0.0)
                        .child(icon(&icons::ARCHIVE_RESTORE, 14.0).color(t.text_base))
                        .child(text(label).font(k.ty.ui_medium).color(t.text_base)),
                )
                .child(
                    text(format_byte_size(entry.size_bytes))
                        .font(k.ty.small)
                        .color(t.text_muted),
                ),
        )
        .child(meta_row)
}

/// Renders the Backups settings page.
pub fn view(s: &AppState, k: &Kit, t: &ThemeTokens) -> PageContent {
    let targets = management_targets(s);
    let active_target = s
        .resolve_management_workspace_id()
        .and_then(|id| targets.iter().find(|entry| entry.id == id))
        .or_else(|| targets.first());

    let mut header_actions: Vec<El> = Vec::new();
    if let Some(target) = active_target {
        let ws_refresh = target.id.clone();
        header_actions.push(
            Button::new("Refresh backups")
                .variant(ButtonVariant::Outline)
                .icon(&icons::REFRESH_CCW)
                .control_size(ControlSize::Regular)
                .on_press(move |s: &mut AppState| {
                    s.dispatch(Action::Settings(SettingsAction::ListBackups {
                        workspace_id: ws_refresh.clone(),
                    }));
                })
                .build(k),
        );

        let active_session = s
            .threads
            .iter()
            .find(|th| th.workspace_id == target.id && !th.archived)
            .map(|th| th.id.clone());
        if let Some(session_id) = active_session {
            let ws_create = target.id.clone();
            header_actions.push(
                Button::new("Create checkpoint")
                    .variant(ButtonVariant::Contrast)
                    .icon(&icons::SAVE)
                    .control_size(ControlSize::Regular)
                    .on_press(move |s: &mut AppState| {
                        s.dispatch(Action::Settings(SettingsAction::CreateBackup {
                            workspace_id: ws_create.clone(),
                            target_session_id: session_id.clone(),
                        }));
                    })
                    .build(k),
            );
        }
    }

    let mut blocks: Vec<El> = Vec::new();

    if let Some(target) = active_target {
        let ws_record = s.workspaces.iter().find(|w| w.id == target.id);
        let backups_enabled = ws_record.is_some_and(|w| w.default_backups_enabled);
        let ws_toggle = target.id.clone();
        blocks.push(
            Section::new()
                .title("Workspace backup defaults")
                .description(
                    "Automatic checkpoints preserve file state before edits across sessions.",
                )
                .child(
                    SettingsRow::new(format!("Automatic backups for {}", target.label))
                        .description(target.path.clone())
                        .control(mini_switch(
                            backups_enabled,
                            "Enable automatic backups",
                            false,
                            move |s: &mut AppState| {
                                s.dispatch(Action::Settings(
                                    SettingsAction::UpdateWorkspaceDefaults {
                                        workspace_id: ws_toggle.clone(),
                                        defaults: json!({
                                            "defaultBackupsEnabled": !backups_enabled
                                        }),
                                    },
                                ));
                            },
                            k,
                        ))
                        .build(k, t),
                )
                .build(k, t),
        );
    }

    let filter = s
        .settings_ui
        .backup_file_query_edit
        .text
        .trim()
        .to_ascii_lowercase();
    let target_backups = active_target
        .map(|target| s.backups_for_workspace(&target.id))
        .unwrap_or(&[]);
    let visible_backups: Vec<BackupRowItem> = collect_backup_rows(target_backups)
        .into_iter()
        .filter(|b| {
            filter.is_empty()
                || b.label.to_ascii_lowercase().contains(&filter)
                || b.selection_id.to_ascii_lowercase().contains(&filter)
                || b.session_id.to_ascii_lowercase().contains(&filter)
                || b.session_title.to_ascii_lowercase().contains(&filter)
                || b.checkpoint_id
                    .as_deref()
                    .is_some_and(|cp| cp.to_ascii_lowercase().contains(&filter))
                || b.trigger
                    .as_deref()
                    .is_some_and(|tr| tr.to_ascii_lowercase().contains(&filter))
        })
        .collect();

    let selected_backup = s
        .settings_ui
        .backup_selected_id
        .as_deref()
        .and_then(|sel| visible_backups.iter().find(|b| b.selection_id == sel))
        .or_else(|| visible_backups.first());

    let mut rail = col()
        .w(290.0)
        .min_w(260.0)
        .gap(10.0)
        .px(12.0)
        .py(12.0)
        .border_sides([0.0, 1.0, 0.0, 0.0], t.border_muted)
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .child(
                    text("Snapshots")
                        .font(k.ty.small_medium)
                        .color(t.text_muted),
                )
                .child(status_pill(
                    format!("{}", visible_backups.len()),
                    StatusTone::Neutral,
                    k,
                    t,
                )),
        )
        .child(search_input(
            &s.settings_ui.backup_file_query_edit,
            "Filter snapshots",
            "Search snapshots...",
            None,
            |s: &mut AppState| &mut s.settings_ui.backup_file_query_edit,
            |s: &mut AppState, _tx| {
                s.settings_ui.backup_file_query_edit = TextEdit::new("");
            },
            k,
        ));

    if visible_backups.is_empty() {
        rail = rail.child(
            text("No snapshots loaded.")
                .font(k.ty.small)
                .color(t.text_muted)
                .wrap(),
        );
    } else {
        for entry in &visible_backups {
            let is_selected =
                selected_backup.is_some_and(|sel| sel.selection_id == entry.selection_id);
            rail = rail.child(backup_list_item(entry, is_selected, k, t));
        }
    }

    let detail_pane = match (active_target, selected_backup) {
        (_, None) => col().grow(1.0).px(20.0).py(20.0).child(
            EmptyState::new("No backups available")
                .icon(&icons::ARCHIVE_RESTORE)
                .description(
                    "Snapshots capture pre-edit file states for safe point-in-time recovery.",
                )
                .build(k, t),
        ),
        (target_opt, Some(snapshot)) => {
            let title = if snapshot.label.trim().is_empty() {
                snapshot.selection_id.as_str()
            } else {
                snapshot.label.trim()
            };
            let session_id = snapshot.session_id.as_str();
            let checkpoint_opt = snapshot.checkpoint_id.as_deref();
            let backup_id_for_delete = snapshot.selection_id.clone();

            let mut actions = row().w_full().min_w(0.0).gap(8.0).flex_wrap();
            if let Some(target) = target_opt {
                if let Some(cp_id) = checkpoint_opt {
                    let ws_inspect = target.id.clone();
                    let sid = session_id.to_string();
                    let cp = cp_id.to_string();
                    actions = actions.child(
                        Button::new("Inspect delta")
                            .variant(ButtonVariant::Outline)
                            .control_size(ControlSize::Regular)
                            .on_press(move |s: &mut AppState| {
                                s.dispatch(Action::Settings(SettingsAction::InspectBackup {
                                    workspace_id: ws_inspect.clone(),
                                    target_session_id: sid.clone(),
                                    checkpoint_id: cp.clone(),
                                }));
                            })
                            .build(k)
                            .key("backup-inspect-btn"),
                    );
                }

                actions = actions.child(
                    Button::new(if checkpoint_opt.is_some() {
                        "Restore checkpoint"
                    } else {
                        "Restore backup"
                    })
                    .variant(ButtonVariant::Contrast)
                    .icon(&icons::REFRESH_CCW)
                    .control_size(ControlSize::Regular)
                    .on_press(|s: &mut AppState| {
                        s.settings_ui.backup_restore_confirm_open = true;
                    })
                    .build(k)
                    .key("backup-restore-btn"),
                );

                actions = actions.child(
                    Button::new(if checkpoint_opt.is_some() {
                        "Delete snapshot"
                    } else {
                        "Delete backup"
                    })
                    .variant(ButtonVariant::Outline)
                    .icon(&icons::TRASH)
                    .control_size(ControlSize::Regular)
                    .on_press(move |s: &mut AppState| {
                        s.settings_ui.backup_delete_confirm_id = Some(backup_id_for_delete.clone());
                    })
                    .build(k)
                    .key("backup-delete-btn"),
                );
            }

            let mut detail_col = col()
                .grow(1.0)
                .min_w(0.0)
                .px(20.0)
                .py(20.0)
                .gap(16.0)
                .child(
                    col()
                        .gap(4.0)
                        .child(
                            text(if checkpoint_opt.is_some() {
                                "Selected checkpoint"
                            } else {
                                "Selected backup"
                            })
                            .font(k.ty.small_medium)
                            .color(t.text_muted),
                        )
                        .child(text(title).font(t.title).color(t.text_base))
                        .child(
                            text(format!("Snapshot ID: {}", snapshot.selection_id))
                                .font(t.code)
                                .color(t.text_muted),
                        ),
                )
                .child(
                    row()
                        .w_full()
                        .gap(12.0)
                        .child(stat_tile(
                            "Created",
                            format_timestamp_friendly(snapshot.created_at),
                            None,
                            k,
                            t,
                        ))
                        .child(stat_tile(
                            "Storage",
                            format_byte_size(snapshot.size_bytes),
                            None,
                            k,
                            t,
                        )),
                )
                .child(actions);

            if let Some(cp_id) = checkpoint_opt
                && let Some(delta) =
                    active_target.and_then(|target| s.backup_delta_for_workspace(&target.id))
                && delta.target_session_id == session_id
                && delta.checkpoint_id == cp_id
            {
                let mut delta_box = col()
                    .key("backup-delta-summary")
                    .w_full()
                    .px(12.0)
                    .py(10.0)
                    .gap(6.0)
                    .radius(k.radius.md)
                    .fill(t.elevated_bg)
                    .border(1.0, t.border_muted)
                    .child(
                        text(format!(
                            "Delta: +{} added · ~{} modified · -{} deleted",
                            delta.added, delta.modified, delta.deleted
                        ))
                        .font(k.ty.small_medium)
                        .color(t.text_base),
                    );
                for file in delta.files.iter().take(12) {
                    delta_box = delta_box.child(
                        text(format!("{}  {}", file.change, file.path))
                            .font(t.code)
                            .color(t.text_muted),
                    );
                }
                detail_col = detail_col.child(delta_box);
            }

            detail_col.child(
                text("Restoring overwrites modified workspace files with this snapshot while recording a safety checkpoint.")
                    .font(k.ty.small)
                    .color(t.text_muted)
                    .wrap(),
            )
        }
    };

    let split_card = el()
        .w_full()
        .radius(k.radius.lg)
        .fill(t.panel_bg)
        .border(1.0, t.border_muted)
        .child(
            row()
                .w_full()
                .items_stretch()
                .child(rail)
                .child(detail_pane),
        );
    blocks.push(split_card);

    let mut overlays = Vec::new();
    if let (Some(target), Some(snapshot)) = (active_target, selected_backup) {
        let ws_restore = target.id.clone();
        let backup_id_restore = snapshot.selection_id.clone();
        confirm_dialog(
            ConfirmDialogSpec {
                key: "backup-restore-confirm",
                open: s.settings_ui.backup_restore_confirm_open,
                title: "Restore workspace from backup?",
                description: format!(
                    "Overwrites modified files in {} using snapshot {}. A safety checkpoint is created first.",
                    target.label, snapshot.selection_id
                ),
                confirm_label: "Restore backup",
                danger: true,
            },
            |s| {
                s.settings_ui.backup_restore_confirm_open = false;
            },
            move |s| {
                s.settings_ui.backup_restore_confirm_open = false;
                let (session_id, cp_opt) = split_backup_id(&backup_id_restore);
                if let Some(cp_id) = cp_opt {
                    s.dispatch(Action::Settings(SettingsAction::RestoreBackupCheckpoint {
                        workspace_id: ws_restore.clone(),
                        target_session_id: session_id.to_string(),
                        checkpoint_id: Some(cp_id.to_string()),
                    }));
                } else {
                    s.dispatch(Action::Settings(SettingsAction::RestoreBackup {
                        workspace_id: ws_restore.clone(),
                        backup_id: backup_id_restore.clone(),
                    }));
                }
            },
            k,
            &mut overlays,
        );

        let del_id = s.settings_ui.backup_delete_confirm_id.clone();
        let ws_del = target.id.clone();
        let is_cp_delete = del_id
            .as_deref()
            .and_then(|id| split_backup_id(id).1)
            .is_some();
        confirm_dialog(
            ConfirmDialogSpec {
                key: "backup-delete-confirm",
                open: del_id.is_some(),
                title: if is_cp_delete {
                    "Delete backup checkpoint?"
                } else {
                    "Delete backup entry?"
                },
                description: if is_cp_delete {
                    format!(
                        "Permanently removes checkpoint {} from backup storage.",
                        del_id.as_deref().unwrap_or("")
                    )
                } else {
                    format!(
                        "Permanently removes backup {} and its checkpoints from backup storage.",
                        del_id.as_deref().unwrap_or("")
                    )
                },
                confirm_label: if is_cp_delete {
                    "Delete checkpoint"
                } else {
                    "Delete backup"
                },
                danger: true,
            },
            |s| {
                s.settings_ui.backup_delete_confirm_id = None;
            },
            move |s| {
                if let Some(id) = s.settings_ui.backup_delete_confirm_id.take() {
                    let (session_id, cp_opt) = split_backup_id(&id);
                    if let Some(cp_id) = cp_opt {
                        s.dispatch(Action::Settings(SettingsAction::DeleteBackup {
                            workspace_id: ws_del.clone(),
                            target_session_id: session_id.to_string(),
                            checkpoint_id: cp_id.to_string(),
                        }));
                    } else {
                        s.dispatch(Action::Settings(SettingsAction::DeleteBackupEntry {
                            workspace_id: ws_del.clone(),
                            target_session_id: session_id.to_string(),
                        }));
                    }
                }
            },
            k,
            &mut overlays,
        );
    }

    PageContent::simple(settings_page(blocks))
        .with_header_actions(header_actions)
        .with_overlays(overlays)
}
