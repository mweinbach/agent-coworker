//! Top-level shell overlays: Toast stack (with OperationFeedback inline claim
//! suppression), Sidebar search overlay, Delete confirmation, Workflow run detail,
//! External URL modal, Confirm Dialog, LM Studio prompt, and Onboarding.

use std::collections::HashMap;

use cowork_protocol::CreationRepairAction;
use rune::{El, Icon, ScrollSpec, col, el, icon, row, spacer, text};
use rune_kit::{
    Badge, BadgeVariant, Button, ButtonVariant, ControlSize, Dialog, Kit, TextInput, Toast,
    ToastRegion,
};

use crate::actions::{Action, ChatAction, NativeAction, NavAction, ShellAction};
use crate::router::SettingsPageId;
use crate::state::{
    AppState, ConfirmDialogRequest, NotificationTone, WorkflowRunView, dismiss_toast,
};
use crate::theme::ThemeTokens;

pub(crate) use super::onboarding::is_onboarding_visible;
use super::{helpers, icons, onboarding, palette};

pub(crate) struct SearchOverlayItem {
    pub(crate) key: String,
    pub(crate) section: &'static str,
    pub(crate) title: String,
    pub(crate) subtitle: String,
    pub(crate) icon_glyph: &'static Icon,
    pub(crate) action: Action,
}

/// Collect all shell-managed overlays plus subview overlays for `rune_kit::root`.
pub fn build_overlays(
    s: &AppState,
    k: &Kit,
    t: &ThemeTokens,
    mut subview_overlays: Vec<El>,
) -> Vec<El> {
    if let Some(pal) = palette::build_command_palette(s, k, t) {
        subview_overlays.push(pal);
    }

    if let Some(search) = build_sidebar_search_overlay(s, k, t) {
        subview_overlays.push(search);
    }

    onboarding::push_onboarding_overlays(s, k, t, &mut subview_overlays);

    push_lmstudio_start_modal(s, k, t, &mut subview_overlays);
    push_external_url_dialog(
        s.pending_external_url.as_deref(),
        k,
        t,
        &mut subview_overlays,
    );
    push_confirm_dialog(
        s.pending_confirm_dialog.as_ref(),
        k,
        t,
        &mut subview_overlays,
    );
    push_delete_thread_confirm_dialog(s, k, t, &mut subview_overlays);
    push_trash_entry_confirm_dialog(s, k, t, &mut subview_overlays);
    push_workflow_run_detail_dialog(s, k, t, &mut subview_overlays);

    if let Some(toasts) = build_toast_region(s, k, t) {
        subview_overlays.push(toasts);
    }

    subview_overlays
}

fn is_toast_claimed_inline(s: &AppState, toast_key: &str) -> bool {
    let Some(op) = s.operations_by_key.get(toast_key) else {
        return false;
    };
    op.busy && op.error.is_none()
}

fn build_toast_region(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    let visible: Vec<_> = s
        .toasts
        .iter()
        .filter(|toast| !is_toast_claimed_inline(s, &toast.key))
        .collect();

    if visible.is_empty() {
        return None;
    }

    let mut region = ToastRegion::new();
    for toast in visible.into_iter().take(5) {
        let key_for_close = toast.key.clone();
        let (glyph, tint) = match toast.tone {
            NotificationTone::Success => (&icons::CHECK_CIRCLE, t.success),
            NotificationTone::Warning => (&icons::ALERT_TRIANGLE, t.warning),
            NotificationTone::Error => (&icons::ALERT_TRIANGLE, t.danger),
            NotificationTone::Info => (&icons::INFO, t.info),
        };
        let mut built = Toast::new(toast.key.clone(), toast.title.clone())
            .icon(k, glyph)
            .on_close(move |s: &mut AppState| {
                dismiss_toast(s, key_for_close.clone());
            });
        if let Some(desc) = toast.description.as_deref() {
            built = built.description(desc);
        }
        let el_toast = built.build(k).border(1.0, tint);
        region = region.toast(el_toast);
    }

    Some(region.build(k))
}

pub(crate) fn extract_external_url_domain(raw_url: &str) -> String {
    match url::Url::parse(raw_url) {
        Ok(parsed) => parsed
            .host_str()
            .filter(|host| !host.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| parsed.scheme().to_owned()),
        Err(_) => "unknown destination".to_owned(),
    }
}

/// Wraps modal content (and optional description) with padding matching `Dialog`'s header
/// so wrapped descriptions and footers never clip or sit flush against modal borders.
fn padded_dialog_body(desc: Option<&str>, content: El, t: &ThemeTokens) -> El {
    let mut wrap = col().w_full().px(16.0).pb(16.0).gap(12.0);
    if let Some(text_str) = desc.filter(|d| !d.trim().is_empty()) {
        wrap = wrap.child(text(text_str).font(t.body).color(t.text_muted).wrap());
    }
    wrap.child(content)
}

fn push_external_url_dialog(url: Option<&str>, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) {
    let Some(url) = url else {
        return;
    };
    let domain = extract_external_url_domain(url);
    let desc = format!("Review the destination domain ({domain}) before opening in your browser.");

    Dialog::new("confirm-external-url-dialog", "Open external link?")
        .open(true)
        .width(440.0)
        .fit()
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::DismissExternalUrl));
        })
        .child(padded_dialog_body(
            Some(&desc),
            col()
                .w_full()
                .gap(12.0)
                .child(
                    el().w_full()
                        .px(10.0)
                        .py(8.0)
                        .radius(6.0)
                        .fill(t.elevated_bg)
                        .border(1.0, t.border_muted)
                        .child(text(url).font(t.code).color(t.text_base).wrap()),
                )
                .child(
                    row()
                        .w_full()
                        .gap(8.0)
                        .child(spacer())
                        .child(
                            Button::new("Cancel")
                                .variant(ButtonVariant::Ghost)
                                .on_press_tx(|s: &mut AppState, _| {
                                    s.dispatch(Action::Shell(ShellAction::DismissExternalUrl));
                                })
                                .build(k),
                        )
                        .child(
                            Button::new("Open link")
                                .variant(ButtonVariant::Contrast)
                                .icon(&icons::EXTERNAL_LINK)
                                .on_press_tx(|s: &mut AppState, _| {
                                    s.dispatch(Action::Shell(ShellAction::ConfirmExternalUrl));
                                })
                                .build(k),
                        ),
                ),
            t,
        ))
        .build(k, layer);
}

fn push_confirm_dialog(
    pending: Option<&ConfirmDialogRequest>,
    k: &Kit,
    t: &ThemeTokens,
    layer: &mut Vec<El>,
) {
    let Some(pending) = pending else {
        return;
    };
    let confirm_variant = if pending.destructive {
        ButtonVariant::Danger
    } else {
        ButtonVariant::Contrast
    };
    let confirm_label = if pending.confirm_label.is_empty() {
        "Confirm".to_owned()
    } else {
        pending.confirm_label.clone()
    };
    let cancel_label = if pending.cancel_label.is_empty() {
        "Cancel".to_owned()
    } else {
        pending.cancel_label.clone()
    };

    let id_close = pending.id.clone();
    let id_cancel = pending.id.clone();
    let id_confirm = pending.id.clone();
    let msg = (!pending.message.trim().is_empty()).then_some(pending.message.as_str());

    Dialog::new("shell-confirm-dialog", pending.title.clone())
        .open(true)
        .width(420.0)
        .fit()
        .click_outside(true)
        .on_close(move |s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                id: id_close.clone(),
                confirmed: false,
            }));
        })
        .child(padded_dialog_body(
            msg,
            row()
                .w_full()
                .pt(4.0)
                .gap(8.0)
                .child(spacer())
                .child(
                    Button::new(cancel_label)
                        .variant(ButtonVariant::Ghost)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                                id: id_cancel.clone(),
                                confirmed: false,
                            }));
                        })
                        .build(k),
                )
                .child(
                    Button::new(confirm_label)
                        .variant(confirm_variant)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                                id: id_confirm.clone(),
                                confirmed: true,
                            }));
                        })
                        .build(k),
                ),
            t,
        ))
        .build(k, layer);
}

fn push_lmstudio_start_modal(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) {
    let Some(modal) = s.lmstudio_start_modal.as_ref() else {
        return;
    };
    let desc = match modal.base_url.as_deref() {
        Some(url) if !url.is_empty() => format!(
            "LM Studio local inference at {url} is configured, but the local server is not running."
        ),
        _ => "LM Studio local inference is configured, but the local server does not appear to be running.".to_owned(),
    };

    let mut body = col().gap(12.0);
    if let Some(err) = modal.error.as_deref() {
        body = body.child(
            el().w_full()
                .padding(10.0)
                .radius(6.0)
                .fill(t.elevated_bg)
                .border(1.0, t.danger)
                .child(text(err).font(t.caption).color(t.danger).wrap()),
        );
    }

    let ws_for_start = Some(modal.workspace_id.clone());
    let base_url = modal
        .base_url
        .clone()
        .unwrap_or_else(|| "http://127.0.0.1:1234/v1".to_owned());

    body = body.child(
        row()
            .w_full()
            .gap(8.0)
            .child(
                Button::new("Provider settings")
                    .variant(ButtonVariant::Ghost)
                    .control_size(ControlSize::Small)
                    .on_press_tx(|s: &mut AppState, tx| {
                        s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
                        s.dispatch_tx(
                            Action::Navigate(NavAction::OpenSettingsIntent {
                                page: SettingsPageId::Models,
                                tab: None,
                                section: None,
                                new_provider: false,
                            }),
                            tx,
                        );
                    })
                    .build(k),
            )
            .child(spacer())
            .child(
                Button::new("Cancel")
                    .variant(ButtonVariant::Ghost)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
                    })
                    .build(k),
            )
            .child(
                Button::new(if modal.starting {
                    "Starting..."
                } else {
                    "Start LM Studio"
                })
                .variant(ButtonVariant::Contrast)
                .disabled(modal.starting)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.dispatch(Action::Shell(ShellAction::RepairCreationReadiness {
                        action: CreationRepairAction::StartLmStudio {
                            base_url: base_url.clone(),
                            can_auto_start: true,
                        },
                        workspace_id: ws_for_start.clone(),
                    }));
                    s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
                })
                .build(k),
            ),
    );

    Dialog::new("lmstudio-start-dialog", "Start LM Studio server?")
        .open(true)
        .width(440.0)
        .fit()
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
        })
        .child(padded_dialog_body(Some(&desc), body, t))
        .build(k, layer);
}

pub(crate) fn collect_search_overlay_items(s: &AppState) -> Vec<SearchOverlayItem> {
    let trimmed = s.shell_ui.search_edit.text.trim();
    let query = if trimmed.is_empty() {
        String::new()
    } else if trimmed.is_ascii() {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_lowercase()
    };
    let ws_filter = s.shell_ui.search_workspace_filter.as_deref();
    let mut items = Vec::new();

    // Index workspace names once (O(W)) instead of O(T * W) linear scans per thread/task.
    let ws_names: HashMap<&str, &str> = s
        .workspaces
        .iter()
        .map(|w| (w.id.as_str(), w.name.as_str()))
        .collect();

    // Filter matching threads BEFORE partial-sorting the top 15 by `updated_at` descending.
    let mut matching_threads: Vec<&crate::state::ThreadRecord> = s
        .threads
        .iter()
        .filter(|th| th.is_standard_chat())
        .filter(|th| ws_filter.is_none_or(|wid| th.workspace_id == wid))
        .filter(|th| {
            if query.is_empty() {
                return true;
            }
            let ws_name = ws_names
                .get(th.workspace_id.as_str())
                .copied()
                .unwrap_or("Chat");
            let title = if th.title.trim().is_empty() {
                "New chat"
            } else {
                th.title.as_str()
            };
            helpers::contains_case_insensitive(title, &query)
                || helpers::contains_case_insensitive(ws_name, &query)
                || th
                    .preview
                    .as_deref()
                    .is_some_and(|p| helpers::contains_case_insensitive(p, &query))
        })
        .collect();

    if matching_threads.len() > 15 {
        matching_threads.select_nth_unstable_by(15, |a, b| b.updated_at.cmp(&a.updated_at));
        matching_threads.truncate(15);
    }
    matching_threads.sort_by_key(|b| std::cmp::Reverse(b.updated_at));

    for th in matching_threads {
        let ws_name = ws_names
            .get(th.workspace_id.as_str())
            .copied()
            .unwrap_or("Chat");
        let title = if th.title.trim().is_empty() {
            "New chat".to_owned()
        } else {
            th.title.clone()
        };
        let age = helpers::format_relative_age(th.updated_at, s.now_secs);
        let subtitle = if age.is_empty() {
            ws_name.to_owned()
        } else {
            format!("{ws_name} · {age}")
        };
        items.push(SearchOverlayItem {
            key: format!("sr-th-{}", th.id),
            section: "Chats",
            title,
            subtitle,
            icon_glyph: &icons::MESSAGE,
            action: Action::Navigate(NavAction::OpenThread(th.id.clone())),
        });
    }

    for ws in s
        .workspaces
        .iter()
        .filter(|w| ws_filter.is_none_or(|wid| wid == w.id))
        .filter(|w| {
            query.is_empty()
                || helpers::contains_case_insensitive(&w.name, &query)
                || helpers::contains_case_insensitive(&w.path, &query)
        })
        .take(8)
    {
        items.push(SearchOverlayItem {
            key: format!("sr-ws-{}", ws.id),
            section: "Projects",
            title: ws.name.clone(),
            subtitle: ws.path.clone(),
            icon_glyph: &icons::FOLDER,
            action: Action::Navigate(NavAction::SelectWorkspace(ws.id.clone())),
        });
    }

    if helpers::tasks_feature_enabled(s) {
        let mut task_count = 0usize;
        for sum in &s.tasks {
            if let Some(wid) = ws_filter
                && sum.workspace_id != wid
            {
                continue;
            }
            let matches = query.is_empty()
                || helpers::contains_case_insensitive(&sum.title, &query)
                || helpers::contains_case_insensitive(&sum.objective, &query)
                || helpers::contains_case_insensitive(&sum.status, &query);
            if !matches {
                continue;
            }
            let ws_name = ws_names
                .get(sum.workspace_id.as_str())
                .copied()
                .unwrap_or("Workspace");
            items.push(SearchOverlayItem {
                key: format!("sr-task-{}", sum.id),
                section: "Tasks",
                title: sum.title.clone(),
                subtitle: format!("{ws_name} · {}", sum.status),
                icon_glyph: &icons::CHECK_SQUARE,
                action: Action::Navigate(NavAction::OpenTask(sum.id.clone())),
            });
            task_count += 1;
            if task_count >= 10 {
                break;
            }
        }
    }

    items.truncate(32);
    items
}

fn build_sidebar_search_overlay(s: &AppState, k: &Kit, t: &ThemeTokens) -> Option<El> {
    if !s.shell_ui.search_overlay_open {
        return None;
    }

    let items = collect_search_overlay_items(s);
    let selected_idx = s
        .shell_ui
        .search_selected
        .min(items.len().saturating_sub(1));

    let search_input = TextInput::new(&s.shell_ui.search_edit)
        .placeholder("Search chats, projects, and tasks...")
        .label("Search conversations and workspaces")
        .leading_icon(&icons::SEARCH)
        .width(None)
        .clear_button()
        .on_edit(|s: &mut AppState| &mut s.shell_ui.search_edit)
        .on_change(|s: &mut AppState, _| {
            s.shell_ui.search_selected = 0;
        })
        .on_key(|s: &mut AppState, ev, tx| {
            let quick_slot = if !ev.mods.alt && !ev.mods.shift {
                ['1', '2', '3', '4', '5', '6', '7', '8', '9']
                    .into_iter()
                    .position(|digit| ev.is_command(digit))
            } else {
                None
            };
            if let Some(slot) = quick_slot {
                let items = collect_search_overlay_items(s);
                if let Some(item) = items.get(slot) {
                    s.shell_ui.search_overlay_open = false;
                    s.shell_ui.search_selected = 0;
                    s.dispatch_tx(item.action.clone(), tx);
                    return true;
                }
            }
            match ev.key {
                rune::Key::Up => {
                    s.shell_ui.search_selected = s.shell_ui.search_selected.saturating_sub(1);
                    true
                }
                rune::Key::Down => {
                    let items = collect_search_overlay_items(s);
                    if !items.is_empty() {
                        let max_idx = items.len().saturating_sub(1);
                        s.shell_ui.search_selected = (s.shell_ui.search_selected + 1).min(max_idx);
                    }
                    true
                }
                rune::Key::Escape => {
                    s.shell_ui.search_overlay_open = false;
                    s.shell_ui.search_selected = 0;
                    true
                }
                _ => false,
            }
        })
        .on_action(|s: &mut AppState, tx| {
            let items = collect_search_overlay_items(s);
            let max_idx = items.len().saturating_sub(1);
            if let Some(item) = items.get(s.shell_ui.search_selected.min(max_idx)) {
                let act = item.action.clone();
                s.shell_ui.search_overlay_open = false;
                s.shell_ui.search_selected = 0;
                s.dispatch_tx(act, tx);
            }
        })
        .build(k);

    let mut chips = row()
        .key("search-overlay-workspace-filters")
        .w_full()
        .px(12.0)
        .py(6.0)
        .gap(6.0)
        .center_y()
        .child(
            Button::new("All projects")
                .variant(if s.shell_ui.search_workspace_filter.is_none() {
                    ButtonVariant::Contrast
                } else {
                    ButtonVariant::Ghost
                })
                .control_size(ControlSize::Small)
                .on_press_tx(|s: &mut AppState, _| {
                    s.shell_ui.search_workspace_filter = None;
                    s.shell_ui.search_selected = 0;
                })
                .build(k),
        );

    for ws in s.workspaces.iter().take(5) {
        let wid = ws.id.clone();
        let active = s.shell_ui.search_workspace_filter.as_deref() == Some(ws.id.as_str());
        chips = chips.child(
            Button::new(ws.name.clone())
                .variant(if active {
                    ButtonVariant::Contrast
                } else {
                    ButtonVariant::Ghost
                })
                .control_size(ControlSize::Small)
                .on_press_tx(move |s: &mut AppState, _| {
                    if s.shell_ui.search_workspace_filter.as_deref() == Some(wid.as_str()) {
                        s.shell_ui.search_workspace_filter = None;
                    } else {
                        s.shell_ui.search_workspace_filter = Some(wid.clone());
                    }
                    s.shell_ui.search_selected = 0;
                })
                .build(k),
        );
    }

    let mut list_children: Vec<El> = Vec::new();
    if items.is_empty() {
        list_children.push(
            el().w_full().px(16.0).py(28.0).center().child(
                text("No chats, projects, or tasks match your search.")
                    .font(t.body)
                    .color(t.text_muted),
            ),
        );
    } else {
        let mut last_section: Option<&'static str> = None;
        for (idx, item) in items.into_iter().enumerate() {
            if last_section != Some(item.section) {
                last_section = Some(item.section);
                list_children.push(
                    el().key(format!("sr-sec-{}", item.section))
                        .w_full()
                        .pt(8.0)
                        .pb(4.0)
                        .px(10.0)
                        .child(text(item.section).font(t.caption).color(t.text_faint)),
                );
            }
            let selected = idx == selected_idx;
            let action = item.action;
            let shortcut_badge = (idx < 9).then(|| {
                Badge::new(crate::shortcut_label(&format!("Cmd+{}", idx + 1)))
                    .variant(BadgeVariant::Neutral)
                    .build(k)
            });
            let mut row_el = row()
                .key(item.key)
                .w_full()
                .px(10.0)
                .py(7.0)
                .radius(8.0)
                .gap(10.0)
                .center_y()
                .focusable(true)
                .on_press_tx(move |s: &mut AppState, tx| {
                    s.shell_ui.search_overlay_open = false;
                    s.shell_ui.search_selected = 0;
                    s.dispatch_tx(action.clone(), tx);
                })
                .child(icon(item.icon_glyph, 15.0).color(if selected {
                    t.accent
                } else {
                    t.text_muted
                }))
                .child(
                    col()
                        .grow(1.0)
                        .shrink()
                        .gap(1.0)
                        .child(text(item.title).font(t.label).color(t.text_base).truncate())
                        .child(
                            text(item.subtitle)
                                .font(t.caption)
                                .color(t.text_faint)
                                .truncate(),
                        ),
                )
                .children(shortcut_badge);

            if selected {
                row_el = row_el.fill(t.hover).border(1.0, t.border_muted);
            }
            row_el = k.interactive_with(row_el, t.hover, t.pressed);
            list_children.push(row_el);
        }
    }

    let inner = col()
        .w_full()
        .max_h(518.0)
        .radius(11.0)
        .continuous_corners()
        .clip_rounded(11.0)
        .child(el().w_full().padding(12.0).child(search_input))
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(chips)
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            k.scroll_bar(
                col()
                    .key("search-overlay-results-scroll")
                    .w_full()
                    .max_h(330.0)
                    .scroll(ScrollSpec {
                        stick_bottom: false,
                    })
                    .padding(6.0)
                    .gap(2.0)
                    .children(list_children),
            ),
        )
        .child(el().w_full().h(1.0).fill(t.border_muted))
        .child(
            row()
                .key("search-overlay-footer")
                .w_full()
                .h(34.0)
                .px(14.0)
                .gap(12.0)
                .center_y()
                .corners([0.0, 0.0, 11.0, 11.0])
                .continuous_corners()
                .fill(t.panel_bg)
                .child(
                    text(format!(
                        "↑↓ navigate · Enter open · {} quick jump · Esc close",
                        crate::shortcut_label("Cmd+1-9")
                    ))
                    .font(t.caption)
                    .color(t.text_faint),
                )
                .child(spacer())
                .child(
                    Button::new("Close")
                        .variant(ButtonVariant::Ghost)
                        .control_size(ControlSize::Small)
                        .on_press_tx(|s: &mut AppState, _| {
                            s.shell_ui.search_overlay_open = false;
                            s.shell_ui.search_selected = 0;
                        })
                        .build(k),
                ),
        );

    let card = k.elevate(
        col()
            .key("sidebar-search-overlay-card")
            .w(600.0)
            .max_w(600.0)
            .max_h(520.0)
            .padding(1.0)
            .radius(12.0)
            .continuous_corners()
            .fill(t.popover_bg)
            .border(1.0, t.border_strong)
            .child(inner),
        &k.elevation.overlay,
    );

    Some(
        col()
            .key("sidebar-search-overlay-backdrop")
            .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
            .fill(t.scrim)
            .items_center()
            .pt(72.0)
            .px(16.0)
            .modal(true, |s: &mut AppState| {
                s.shell_ui.search_overlay_open = false;
                s.shell_ui.search_selected = 0;
            })
            .child(card),
    )
}

fn push_delete_thread_confirm_dialog(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) {
    let Some(thread_id) = s.shell_ui.pending_delete_thread_id.as_deref() else {
        return;
    };
    let title = s
        .threads
        .iter()
        .find(|th| th.id == thread_id)
        .map(|th| th.title.as_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("this conversation");
    let tid_for_confirm = thread_id.to_owned();
    let desc =
        format!("Delete \"{title}\"? All messages and artifacts in this chat will be removed.");

    let footer = row()
        .w_full()
        .pt(4.0)
        .gap(8.0)
        .child(spacer())
        .child(
            Button::new("Cancel")
                .variant(ButtonVariant::Ghost)
                .on_press_tx(|s: &mut AppState, _| {
                    s.shell_ui.pending_delete_thread_id = None;
                })
                .build(k),
        )
        .child(
            Button::new("Delete")
                .variant(ButtonVariant::Danger)
                .on_press_tx(move |s: &mut AppState, _| {
                    s.shell_ui.pending_delete_thread_id = None;
                    s.dispatch(Action::Chat(ChatAction::DeleteThread(
                        tid_for_confirm.clone(),
                    )));
                })
                .build(k),
        );

    Dialog::new("delete-thread-dialog", "Delete chat permanently?")
        .open(true)
        .width(420.0)
        .fit()
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.shell_ui.pending_delete_thread_id = None;
        })
        .child(padded_dialog_body(Some(&desc), footer, t))
        .build(k, layer);
}

fn push_trash_entry_confirm_dialog(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) {
    let Some(entry) = s.shell_ui.pending_trash_entry.as_ref() else {
        return;
    };
    let full_path =
        super::context_sidebar::resolve_explorer_fs_path(s, &entry.workspace_id, &entry.path);
    let parent_dir =
        super::context_sidebar::explorer_parent_dir(s, &entry.workspace_id, &entry.path);
    let ws_confirm = entry.workspace_id.clone();
    let kind_label = if entry.is_dir { "directory" } else { "file" };
    let desc = format!("Are you sure you want to move this {kind_label} to the trash?");

    let body = col()
        .w_full()
        .gap(12.0)
        .child(
            el().w_full()
                .px(10.0)
                .py(8.0)
                .radius(6.0)
                .fill(t.elevated_bg)
                .border(1.0, t.border_muted)
                .child(
                    text(full_path.clone())
                        .font(t.code)
                        .color(t.text_base)
                        .wrap(),
                ),
        )
        .child(
            row()
                .w_full()
                .pt(4.0)
                .gap(8.0)
                .child(spacer())
                .child(
                    Button::new("Cancel")
                        .variant(ButtonVariant::Ghost)
                        .on_press_tx(|s: &mut AppState, _| {
                            s.shell_ui.pending_trash_entry = None;
                        })
                        .build(k),
                )
                .child(
                    Button::new("Move to Trash")
                        .variant(ButtonVariant::Danger)
                        .on_press_tx(move |s: &mut AppState, _| {
                            s.shell_ui.pending_trash_entry = None;
                            s.dispatch(Action::Native(NativeAction::TrashPath(full_path.clone())));
                            s.dispatch(Action::Native(NativeAction::ListWorkspaceFiles {
                                workspace_id: ws_confirm.clone(),
                                dir: parent_dir.clone(),
                            }));
                        })
                        .build(k)
                        .key("trash-entry-confirm-btn"),
                ),
        );

    Dialog::new("trash-entry-dialog", "Move to Trash")
        .open(true)
        .width(440.0)
        .fit()
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.shell_ui.pending_trash_entry = None;
        })
        .child(padded_dialog_body(Some(&desc), body, t))
        .build(k, layer);
}

fn find_workflow_run<'a>(s: &'a AppState, run_id: &str) -> Option<&'a WorkflowRunView> {
    s.active_task
        .as_ref()
        .and_then(|task| task.runs.iter().find(|r| r.id == run_id))
        .or_else(|| {
            s.thread_runtime_by_id
                .values()
                .flat_map(|rt| rt.workflow_runs.iter())
                .find(|r| r.id == run_id)
        })
        .or_else(|| s.workflow_runs.iter().find(|r| r.id == run_id))
}

fn format_run_duration(started_at_ms: i64, finished_at_ms: Option<i64>) -> Option<String> {
    let fin = finished_at_ms?;
    if fin < started_at_ms || started_at_ms <= 0 {
        return None;
    }
    let secs = (fin - started_at_ms) / 1000;
    if secs < 60 {
        Some(format!("{secs}s"))
    } else if secs < 3600 {
        Some(format!("{}m {}s", secs / 60, secs % 60))
    } else {
        Some(format!("{}h {}m", secs / 3600, (secs % 3600) / 60))
    }
}

fn push_workflow_run_detail_dialog(s: &AppState, k: &Kit, t: &ThemeTokens, layer: &mut Vec<El>) {
    let Some(run_id) = s.shell_ui.selected_workflow_run_id.as_deref() else {
        return;
    };
    let Some(run) = find_workflow_run(s, run_id) else {
        return;
    };
    let started_rel = helpers::format_relative_age(run.started_at, s.now_secs);
    let duration = format_run_duration(run.started_at, run.finished_at);

    let mut meta = row().w_full().gap(8.0).center_y().child(
        Badge::new(run.status.clone())
            .variant(BadgeVariant::Neutral)
            .build(k),
    );
    if !started_rel.is_empty() {
        meta = meta.child(
            text(format!("Started {started_rel} ago"))
                .font(t.caption)
                .color(t.text_muted),
        );
    }
    if let Some(dur) = duration {
        meta = meta.child(text(format!("· {dur}")).font(t.caption).color(t.text_muted));
    }

    let summary_text = run
        .summary
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("No output summary recorded for this workflow run.")
        .to_owned();

    let body = col()
        .w_full()
        .gap(12.0)
        .child(meta)
        .child(
            text(format!("Run ID: {}", run.id))
                .font(t.code)
                .color(t.text_faint),
        )
        .child(
            col()
                .w_full()
                .max_h(260.0)
                .scroll(ScrollSpec {
                    stick_bottom: false,
                })
                .padding(10.0)
                .radius(8.0)
                .fill(t.elevated_bg)
                .border(1.0, t.border_muted)
                .child(text(summary_text).font(t.body).color(t.text_base).wrap()),
        )
        .child(
            row().w_full().pt(4.0).child(spacer()).child(
                Button::new("Close")
                    .variant(ButtonVariant::Ghost)
                    .on_press_tx(|s: &mut AppState, _| {
                        s.shell_ui.selected_workflow_run_id = None;
                    })
                    .build(k),
            ),
        );

    Dialog::new("workflow-run-detail-dialog", run.workflow_name.as_str())
        .open(true)
        .width(500.0)
        .fit()
        .click_outside(true)
        .on_close(|s: &mut AppState| {
            s.shell_ui.selected_workflow_run_id = None;
        })
        .child(padded_dialog_body(
            Some("Workflow execution summary and runtime metadata."),
            body,
            t,
        ))
        .build(k, layer);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::{Action, NavAction};

    #[test]
    fn onboarding_hidden_in_scene_mode_and_settings() {
        let mut s = AppState::default();
        assert!(is_onboarding_visible(&s));

        s.scene_mode = true;
        assert!(!is_onboarding_visible(&s));
        s.scene_mode = false;

        s.window_mode = crate::state::WindowMode::QuickChat;
        assert!(!is_onboarding_visible(&s));
        s.window_mode = crate::state::WindowMode::Main;

        s.dispatch(Action::Navigate(NavAction::OpenSettings(Some(
            SettingsPageId::Models,
        ))));
        assert!(!is_onboarding_visible(&s));

        s.dispatch(Action::Navigate(NavAction::GoBack));
        assert!(is_onboarding_visible(&s));

        s.onboarding.dismissed = true;
        assert!(!is_onboarding_visible(&s));
    }

    #[test]
    fn external_url_domain_strips_userinfo_query_and_fragment() {
        assert_eq!(
            extract_external_url_domain("https://trusted.com@evil.com/path"),
            "evil.com"
        );
        assert_eq!(
            extract_external_url_domain("https://user:pass@evil.com:8443?next=trusted.com#frag"),
            "evil.com"
        );
        assert_eq!(
            extract_external_url_domain("https://example.org?redirect=evil.com"),
            "example.org"
        );
        assert_eq!(
            extract_external_url_domain("https://example.org#trusted.com"),
            "example.org"
        );
        assert_eq!(
            extract_external_url_domain("mailto:user@example.com"),
            "mailto"
        );
        assert_eq!(
            extract_external_url_domain("not a url"),
            "unknown destination"
        );
    }

    #[test]
    fn search_overlay_collects_and_filters_items() {
        use crate::state::{TaskSummaryView, ThreadRecord, WorkspaceRecord};

        let mut s = AppState::default();
        s.workspaces.push(WorkspaceRecord {
            id: "ws-a".into(),
            name: "Alpha".into(),
            path: "/tmp/alpha".into(),
            ..Default::default()
        });
        s.workspaces.push(WorkspaceRecord {
            id: "ws-b".into(),
            name: "Beta".into(),
            path: "/tmp/beta".into(),
            ..Default::default()
        });
        s.threads.push(ThreadRecord {
            id: "th-1".into(),
            workspace_id: "ws-a".into(),
            title: "Fix compiler error".into(),
            updated_at: 200,
            ..Default::default()
        });
        s.threads.push(ThreadRecord {
            id: "th-2".into(),
            workspace_id: "ws-b".into(),
            title: "Design landing page".into(),
            updated_at: 100,
            ..Default::default()
        });
        s.tasks.push(TaskSummaryView {
            id: "task-1".into(),
            workspace_id: "ws-a".into(),
            title: "Refactor auth".into(),
            status: "running".into(),
            ..Default::default()
        });

        let initial = collect_search_overlay_items(&s);
        assert!(initial.iter().any(|i| i.key == "sr-th-th-1"));
        assert!(initial.iter().any(|i| i.key == "sr-th-th-2"));
        assert!(!initial.iter().any(|i| i.section == "Tasks"));

        s.feature_flags.insert("tasks".into(), true);
        s.shell_ui.search_workspace_filter = Some("ws-a".into());
        let scoped = collect_search_overlay_items(&s);
        assert!(scoped.iter().any(|i| i.key == "sr-th-th-1"));
        assert!(!scoped.iter().any(|i| i.key == "sr-th-th-2"));
        assert!(scoped.iter().any(|i| i.key == "sr-task-task-1"));

        s.shell_ui.search_edit.text = "auth".into();
        let queried = collect_search_overlay_items(&s);
        assert_eq!(queried.len(), 1);
        assert_eq!(queried[0].key, "sr-task-task-1");
    }

    #[test]
    fn finish_setup_completes_onboarding_and_records_final_step() {
        use rune::{Env, Runtime};

        let mut s = AppState::default();
        s.shell_ui.onboarding_step = 4;
        assert!(is_onboarding_visible(&s));

        let mut rt = Runtime::new(
            s,
            |state: &AppState, cx: &mut rune::Cx<AppState>| {
                let (k, t) = crate::theme::build_kit_with_accent(
                    state.effective_dark(cx.system_dark()),
                    state.desktop_settings.reduced_transparency,
                    state.desktop_settings.high_contrast,
                    state.desktop_settings.accent_palette,
                );
                crate::views::shell::view(state, cx, &k, &t)
            },
            (1280.0, 820.0),
            Env::new(true, 1.0),
        );
        rt.frame(0.0);
        let (fx, fy) = rt
            .find("onboarding-finish-setup")
            .expect("Finish setup button must render on final onboarding step");
        rt.pointer_move(fx, fy);
        rt.pointer_down(fx, fy);
        rt.pointer_up(fx, fy);
        rt.frame(0.0);

        assert!(rt.state.onboarding.completed);
        assert!(!rt.state.onboarding.dismissed);
        assert!(rt.state.onboarding.completed_steps.contains("step-5"));
        assert!(!is_onboarding_visible(&rt.state));
    }

    #[test]
    fn onboarding_step2_provider_badge_stays_pill_sized() {
        use rune::{Env, Runtime};

        let mut s = AppState::default();
        s.shell_ui.onboarding_step = 2;

        let mut rt = Runtime::new(
            s,
            |state: &AppState, cx: &mut rune::Cx<AppState>| {
                let (k, t) = crate::theme::build_kit_with_accent(
                    state.effective_dark(cx.system_dark()),
                    state.desktop_settings.reduced_transparency,
                    state.desktop_settings.high_contrast,
                    state.desktop_settings.accent_palette,
                );
                crate::views::shell::view(state, cx, &k, &t)
            },
            (1280.0, 820.0),
            Env::new(true, 1.0),
        );
        rt.frame(0.0);
        let (badge_rect, _) = rt
            .presented("onboarding-provider-badge")
            .expect("provider badge should render on onboarding step 2");
        assert!(
            badge_rect[2] > 0.0 && badge_rect[2] < 280.0,
            "onboarding step 2 provider badge must stay pill-sized rather than stretching full modal width, got w={}",
            badge_rect[2]
        );
    }
}
