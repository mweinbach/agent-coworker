//! Transient shell UI state and global shell keyboard shortcut handling.

use std::collections::{HashMap, HashSet};

use rune::{Key, KeyEvent, PointerPress, TextEdit, Tx};
use rune_kit::shell::Reorder;

use crate::actions::{Action, ChatAction, NavAction, ShellAction};
use crate::router::ViewId;
use crate::state::AppState;

/// Ephemeral UI state owned by `views/shell` (wired onto `AppState` when Step 2 integrates it).
#[derive(Clone)]
pub struct ShellUiState {
    pub viewport_width: f32,
    pub usage_popover_open: bool,
    pub usage_more_details: bool,
    pub needs_input_only: bool,
    pub chats_expanded: bool,
    pub expanded_thread_workspaces: HashSet<String>,
    pub renaming_thread_id: Option<String>,
    pub rename_edit: TextEdit,
    pub context_menu_thread_id: Option<String>,
    pub context_menu_point: Option<PointerPress>,
    pub pending_delete_thread_id: Option<String>,
    pub search_overlay_open: bool,
    pub search_edit: TextEdit,
    pub search_selected: usize,
    pub search_workspace_filter: Option<String>,
    pub command_palette_selected: usize,
    pub sidebar_reorder: Reorder,
    pub onboarding_step: usize,
    pub onboarding_confirm_discard: bool,
    pub selected_workflow_run_id: Option<String>,
    pub task_create_open: bool,
    pub task_create_title_edit: TextEdit,
    pub task_create_objective_edit: TextEdit,
    pub task_feedback_open: bool,
    pub task_feedback_edit: TextEdit,
    pub task_question_dialog_open: bool,
    pub task_question_reply_edit: TextEdit,
    pub task_question_answers: HashMap<String, String>,
    pub task_work_graph_collapsed: bool,
    pub task_inspector_tab: usize,
    pub preview_maximized: bool,
    pub left_overlay_open: bool,
    pub right_overlay_open: bool,
    pub inline_toast_claims: HashMap<String, usize>,
}

impl Default for ShellUiState {
    fn default() -> Self {
        Self {
            viewport_width: 1280.0,
            usage_popover_open: false,
            usage_more_details: false,
            needs_input_only: false,
            chats_expanded: false,
            expanded_thread_workspaces: HashSet::new(),
            renaming_thread_id: None,
            rename_edit: TextEdit::new(""),
            context_menu_thread_id: None,
            context_menu_point: None,
            pending_delete_thread_id: None,
            search_overlay_open: false,
            search_edit: TextEdit::new(""),
            search_selected: 0,
            search_workspace_filter: None,
            command_palette_selected: 0,
            sidebar_reorder: Reorder::new().gap(2.0),
            onboarding_step: 0,
            onboarding_confirm_discard: false,
            selected_workflow_run_id: None,
            task_create_open: false,
            task_create_title_edit: TextEdit::new(""),
            task_create_objective_edit: TextEdit::new(""),
            task_feedback_open: false,
            task_feedback_edit: TextEdit::new(""),
            task_question_dialog_open: false,
            task_question_reply_edit: TextEdit::new(""),
            task_question_answers: HashMap::new(),
            task_work_graph_collapsed: false,
            task_inspector_tab: 0,
            preview_maximized: false,
            left_overlay_open: false,
            right_overlay_open: false,
            inline_toast_claims: HashMap::new(),
        }
    }
}

impl std::fmt::Debug for ShellUiState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellUiState")
            .field("viewport_width", &self.viewport_width)
            .field("usage_popover_open", &self.usage_popover_open)
            .field("needs_input_only", &self.needs_input_only)
            .field("renaming_thread_id", &self.renaming_thread_id)
            .field("search_overlay_open", &self.search_overlay_open)
            .field("onboarding_step", &self.onboarding_step)
            .finish()
    }
}

/// Global keyboard dispatcher for shell shortcuts (`Cmd/Ctrl+K`, `Cmd/Ctrl+Shift+B`, `Cmd/Ctrl+.`, `Escape`).
pub fn handle_key(s: &mut AppState, ev: &KeyEvent, _tx: &mut Tx) -> bool {
    if rune_kit::shell::is_sidebar_toggle(ev)
        || (ev.is_command('b') && !ev.mods.shift && !ev.mods.alt)
    {
        if s.shell_ui.viewport_width < super::helpers::NARROW_BREAKPOINT {
            s.shell_ui.left_overlay_open = !s.shell_ui.left_overlay_open;
            if s.shell_ui.left_overlay_open {
                s.shell_ui.right_overlay_open = false;
            }
        } else {
            s.dispatch(Action::Shell(ShellAction::ToggleSidebar));
        }
        return true;
    }

    if ev.is_command('k') && !ev.mods.alt && !ev.mods.shift {
        s.shell_ui.command_palette_selected = 0;
        s.command_palette_edit.focused = !s.command_palette_open;
        s.dispatch(Action::Shell(ShellAction::ToggleCommandPalette));
        return true;
    }

    if ev.is_command('f') && ev.mods.shift && !ev.mods.alt {
        let opening = !s.shell_ui.search_overlay_open;
        s.shell_ui.search_overlay_open = opening;
        s.shell_ui.search_selected = 0;
        s.shell_ui.search_edit.focused = opening;
        return true;
    }

    if s.command_palette_open {
        let query = s.command_palette_query.trim().to_ascii_lowercase();
        let items = super::palette::collect_palette_items(s, &query);
        let max_idx = items.len().saturating_sub(1);
        match ev.key {
            Key::Up => {
                s.shell_ui.command_palette_selected =
                    s.shell_ui.command_palette_selected.saturating_sub(1);
                return true;
            }
            Key::Down => {
                if !items.is_empty() {
                    s.shell_ui.command_palette_selected =
                        (s.shell_ui.command_palette_selected + 1).min(max_idx);
                }
                return true;
            }
            Key::Enter => {
                if let Some(item) = items.get(s.shell_ui.command_palette_selected.min(max_idx)) {
                    s.shell_ui.command_palette_selected = 0;
                    s.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(false)));
                    s.dispatch(item.action.clone());
                }
                return true;
            }
            _ => {}
        }
    }

    if s.shell_ui.search_overlay_open {
        let items = super::overlays::collect_search_overlay_items(s);
        let max_idx = items.len().saturating_sub(1);
        for (slot, digit) in ['1', '2', '3', '4', '5', '6', '7', '8', '9']
            .into_iter()
            .enumerate()
        {
            if ev.is_command(digit)
                && !ev.mods.alt
                && !ev.mods.shift
                && let Some(item) = items.get(slot)
            {
                s.shell_ui.search_overlay_open = false;
                s.shell_ui.search_selected = 0;
                s.dispatch(item.action.clone());
                return true;
            }
        }
        match ev.key {
            Key::Up => {
                s.shell_ui.search_selected = s.shell_ui.search_selected.saturating_sub(1);
                return true;
            }
            Key::Down => {
                if !items.is_empty() {
                    s.shell_ui.search_selected = (s.shell_ui.search_selected + 1).min(max_idx);
                }
                return true;
            }
            Key::Enter => {
                if let Some(item) = items.get(s.shell_ui.search_selected.min(max_idx)) {
                    s.shell_ui.search_overlay_open = false;
                    s.shell_ui.search_selected = 0;
                    s.dispatch(item.action.clone());
                }
                return true;
            }
            _ => {}
        }
    }

    if ev.is_command('i') && ev.mods.alt {
        if s.shell_ui.viewport_width < super::helpers::NARROW_BREAKPOINT {
            s.shell_ui.right_overlay_open = !s.shell_ui.right_overlay_open;
            if s.shell_ui.right_overlay_open {
                s.shell_ui.left_overlay_open = false;
            }
        } else {
            s.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
        }
        return true;
    }

    if ev.is_command('n') && !ev.mods.shift && !ev.mods.alt {
        let ws = s.active_workspace_id.clone();
        s.dispatch(Action::Navigate(NavAction::OpenNewChat {
            workspace_id: ws,
        }));
        return true;
    }

    if ev.is_command(',') && !ev.mods.shift {
        s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
        return true;
    }

    if ev.is_command('.')
        && let Some(thread_id) = s.route().active_thread_id.clone()
        && let Some(rt) = s.thread_runtime_by_id.get(&thread_id)
        && (rt.streaming || rt.pending_turn_count > 0 || rt.active_turn_id.is_some())
    {
        s.dispatch(Action::Chat(ChatAction::CancelTurn {
            thread_id,
            include_subagents: true,
        }));
        return true;
    }

    if ev.key == Key::Escape {
        return handle_escape(s);
    }

    false
}

/// Dismisses the highest-precedence overlay, preview, or modal route cleanly.
pub fn handle_escape(s: &mut AppState) -> bool {
    if s.command_palette_open {
        s.shell_ui.command_palette_selected = 0;
        s.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(false)));
        return true;
    }
    if s.shell_ui.search_overlay_open {
        s.shell_ui.search_overlay_open = false;
        s.shell_ui.search_selected = 0;
        return true;
    }
    if s.shell_ui.pending_delete_thread_id.is_some() {
        s.shell_ui.pending_delete_thread_id = None;
        return true;
    }
    if s.shell_ui.context_menu_thread_id.is_some() {
        s.shell_ui.context_menu_thread_id = None;
        s.shell_ui.context_menu_point = None;
        return true;
    }
    if s.shell_ui.usage_popover_open {
        s.shell_ui.usage_popover_open = false;
        return true;
    }
    if s.shell_ui.selected_workflow_run_id.is_some() {
        s.shell_ui.selected_workflow_run_id = None;
        return true;
    }
    if s.shell_ui.task_question_dialog_open {
        s.shell_ui.task_question_dialog_open = false;
        return true;
    }
    if s.shell_ui.task_feedback_open {
        s.shell_ui.task_feedback_open = false;
        return true;
    }
    if s.shell_ui.task_create_open {
        s.shell_ui.task_create_open = false;
        return true;
    }
    if s.shell_ui.renaming_thread_id.is_some() {
        s.shell_ui.renaming_thread_id = None;
        return true;
    }
    if s.pending_confirm_dialog.is_some() {
        if let Some(req) = s.pending_confirm_dialog.clone() {
            s.dispatch(Action::Shell(ShellAction::ResolveConfirmDialog {
                id: req.id,
                confirmed: false,
            }));
        }
        return true;
    }
    if s.pending_external_url.is_some() {
        s.dispatch(Action::Shell(ShellAction::DismissExternalUrl));
        return true;
    }
    if s.lmstudio_start_modal.is_some() {
        s.dispatch(Action::Shell(ShellAction::DismissLmStudioStartModal));
        return true;
    }
    if s.shell_ui.onboarding_confirm_discard {
        s.shell_ui.onboarding_confirm_discard = false;
        return true;
    }
    if s.shell_ui.left_overlay_open || s.shell_ui.right_overlay_open {
        s.shell_ui.left_overlay_open = false;
        s.shell_ui.right_overlay_open = false;
        return true;
    }
    if s.active_file_preview.is_some() {
        s.shell_ui.preview_maximized = false;
        s.dispatch(Action::Shell(ShellAction::CloseFilePreview));
        return true;
    }
    if s.route().view == ViewId::Settings {
        if s.nav.can_go_back() {
            s.dispatch(Action::Navigate(NavAction::GoBack));
        } else {
            s.dispatch(Action::Navigate(NavAction::OpenView(ViewId::Chat)));
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ConfirmDialogRequest;

    #[test]
    fn escape_dismisses_highest_priority_overlay_first() {
        let mut s = AppState {
            command_palette_open: true,
            pending_confirm_dialog: Some(ConfirmDialogRequest {
                id: "c1".into(),
                title: "Confirm".into(),
                message: "Proceed?".into(),
                confirm_label: "Yes".into(),
                cancel_label: "No".into(),
                destructive: false,
            }),
            pending_external_url: Some("https://example.com".into()),
            ..Default::default()
        };

        assert!(handle_escape(&mut s));
        assert!(!s.command_palette_open);
        assert!(s.pending_confirm_dialog.is_some());

        assert!(handle_escape(&mut s));
        assert!(s.pending_confirm_dialog.is_none());
        assert!(s.pending_external_url.is_some());

        assert!(handle_escape(&mut s));
        assert!(s.pending_external_url.is_none());

        s.dispatch(Action::Navigate(NavAction::OpenSettings(None)));
        assert_eq!(s.route().view, ViewId::Settings);
        assert!(handle_escape(&mut s));
        assert_eq!(s.route().view, ViewId::Chat);
    }

    #[test]
    fn slice2_escape_and_keyboard_navigation_priority() {
        let mut s = AppState::default();
        s.shell_ui.search_overlay_open = true;
        s.shell_ui.usage_popover_open = true;
        s.shell_ui.selected_workflow_run_id = Some("wf-1".into());
        s.shell_ui.left_overlay_open = true;

        assert!(handle_escape(&mut s));
        assert!(!s.shell_ui.search_overlay_open);
        assert!(s.shell_ui.usage_popover_open);

        assert!(handle_escape(&mut s));
        assert!(!s.shell_ui.usage_popover_open);
        assert!(s.shell_ui.selected_workflow_run_id.is_some());

        assert!(handle_escape(&mut s));
        assert!(s.shell_ui.selected_workflow_run_id.is_none());
        assert!(s.shell_ui.left_overlay_open);

        assert!(handle_escape(&mut s));
        assert!(!s.shell_ui.left_overlay_open);
    }

    #[test]
    fn cmd_b_toggles_sidebar_or_narrow_drawer() {
        let mut s = AppState::default();
        s.shell_ui.viewport_width = 1280.0;
        let initial_open = s.sidebar.is_open();

        let cmd_b = KeyEvent {
            key: Key::Command('b'),
            mods: rune::Mods {
                cmd: true,
                ..Default::default()
            },
        };
        let mut tx = Tx::default();
        assert!(handle_key(&mut s, &cmd_b, &mut tx));
        assert_eq!(s.sidebar.is_open(), !initial_open);
        assert!(!s.shell_ui.left_overlay_open);

        s.shell_ui.viewport_width = 640.0;
        s.shell_ui.right_overlay_open = true;
        assert!(handle_key(&mut s, &cmd_b, &mut tx));
        assert!(s.shell_ui.left_overlay_open);
        assert!(!s.shell_ui.right_overlay_open);
        assert!(handle_key(&mut s, &cmd_b, &mut tx));
        assert!(!s.shell_ui.left_overlay_open);
    }
}
