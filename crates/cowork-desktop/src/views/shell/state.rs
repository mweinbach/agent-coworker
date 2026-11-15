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
    pub expanded_thread_workspaces: HashSet<String>,
    pub renaming_thread_id: Option<String>,
    pub rename_edit: TextEdit,
    pub context_menu_thread_id: Option<String>,
    pub context_menu_point: Option<PointerPress>,
    pub search_overlay_open: bool,
    pub search_selected: usize,
    pub search_workspace_filter: Option<String>,
    pub command_palette_selected: usize,
    pub sidebar_reorder: Reorder,
    pub onboarding_step: usize,
    pub onboarding_confirm_discard: bool,
    pub selected_workflow_run_id: Option<String>,
    pub task_question_dialog_open: bool,
    pub task_question_reply_edit: TextEdit,
    pub task_work_graph_collapsed: bool,
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
            expanded_thread_workspaces: HashSet::new(),
            renaming_thread_id: None,
            rename_edit: TextEdit::new(""),
            context_menu_thread_id: None,
            context_menu_point: None,
            search_overlay_open: false,
            search_selected: 0,
            search_workspace_filter: None,
            command_palette_selected: 0,
            sidebar_reorder: Reorder::new().gap(2.0),
            onboarding_step: 0,
            onboarding_confirm_discard: false,
            selected_workflow_run_id: None,
            task_question_dialog_open: false,
            task_question_reply_edit: TextEdit::new(""),
            task_work_graph_collapsed: false,
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
    if rune_kit::shell::is_sidebar_toggle(ev) {
        s.dispatch(Action::Shell(ShellAction::ToggleSidebar));
        return true;
    }

    if ev.is_command('k') && !ev.mods.alt && !ev.mods.shift {
        s.dispatch(Action::Shell(ShellAction::ToggleCommandPalette));
        return true;
    }

    if ev.is_command('i') && ev.mods.alt {
        s.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
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
        s.dispatch(Action::Shell(ShellAction::SetCommandPaletteOpen(false)));
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
    if s.active_file_preview.is_some() {
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
}
