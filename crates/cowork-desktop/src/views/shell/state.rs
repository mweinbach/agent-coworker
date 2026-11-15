//! Transient shell UI state and global shell keyboard shortcut handling.

use std::collections::{HashMap, HashSet};

use rune::{Key, KeyEvent, PointerPress, TextEdit, Tx};
use rune_kit::shell::{PaneState, Reorder};

use crate::actions::{Action, ChatAction, NavAction, ShellAction};
use crate::router::ViewId;
use crate::state::{AppState, WindowMode};

/// Active context menu target for a workspace file explorer row.
#[derive(Clone, Debug)]
pub struct ExplorerContextMenu {
    pub workspace_id: String,
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    /// Pointer coordinates when triggered via secondary press (`None` when anchored to the row `...` button).
    pub point: Option<PointerPress>,
}

/// Pending destructive confirmation target before trashing a workspace file or directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTrashEntry {
    pub workspace_id: String,
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

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
    pub renaming_file_key: Option<(String, String)>,
    pub renaming_file_edit: TextEdit,
    pub renaming_file_error: Option<String>,
    pub file_context_menu: Option<ExplorerContextMenu>,
    pub pending_trash_entry: Option<PendingTrashEntry>,
    pub canvas_pane: PaneState,
    pub canvas_overlay_dismissed_key: Option<String>,
    pub last_canvas_key: Option<String>,
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
            renaming_file_key: None,
            renaming_file_edit: TextEdit::new(""),
            renaming_file_error: None,
            file_context_menu: None,
            pending_trash_entry: None,
            canvas_pane: PaneState::new(480.0).range(320.0, 900.0),
            canvas_overlay_dismissed_key: None,
            last_canvas_key: None,
        }
    }
}

/// Returns a stable key for the active Canvas session when Canvas handles the right rail.
pub(crate) fn active_canvas_target_key(s: &AppState) -> Option<String> {
    if let Some(ref fx) = s.chat_ui.canvas.fixture {
        return Some(format!("fixture:{}:{}", fx.workspace_id, fx.path));
    }
    if !s.feature_flags.get("canvas").copied().unwrap_or(false) {
        return None;
    }
    if let Some(ref doc) = s.canvas_document {
        return Some(format!(
            "session:{}:{}:{}",
            doc.workspace_id, doc.document_id, doc.generation
        ));
    }
    let preview = s.active_file_preview.as_ref()?;
    if preview.is_binary {
        return None;
    }
    crate::views::chat::canvas::classify_canvas_path(&preview.path)?;
    Some(format!("preview:{}:{}", preview.workspace_id, preview.path))
}

/// True when the active right rail (`Context`, `Task`, or `Canvas`) renders as an overlay drawer.
pub(crate) fn right_rail_uses_overlay(s: &AppState) -> bool {
    let uses_wide_overlay = active_canvas_target_key(s).is_some() || s.route().view == ViewId::Task;
    s.shell_ui.viewport_width < super::helpers::NARROW_BREAKPOINT
        || (uses_wide_overlay && s.shell_ui.viewport_width < super::helpers::FULL_BREAKPOINT)
}

/// True when the compact/narrow right overlay drawer should be visible.
pub(crate) fn is_right_overlay_visible(s: &AppState) -> bool {
    if let Some(key) = active_canvas_target_key(s) {
        s.shell_ui.right_overlay_open
            || s.shell_ui.canvas_overlay_dismissed_key.as_deref() != Some(key.as_str())
    } else {
        s.shell_ui.right_overlay_open
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
pub fn handle_key(s: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
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
        super::palette::toggle_command_palette(s);
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
                    let act = item.action.clone();
                    super::palette::close_command_palette(s);
                    s.dispatch(act);
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
        if right_rail_uses_overlay(s) {
            let next_open = !is_right_overlay_visible(s);
            s.shell_ui.right_overlay_open = next_open;
            if next_open {
                s.shell_ui.left_overlay_open = false;
                s.shell_ui.canvas_overlay_dismissed_key = None;
            } else {
                s.shell_ui.canvas_overlay_dismissed_key = active_canvas_target_key(s);
            }
        } else if active_canvas_target_key(s).is_some() {
            s.shell_ui.canvas_pane.toggle();
        } else {
            s.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
        }
        return true;
    }

    if (ev.is_command('=') || ev.is_command('+')) && !ev.mods.alt {
        s.dispatch(Action::Shell(ShellAction::ZoomIn));
        return true;
    }

    if ev.is_command('-') && !ev.mods.alt {
        s.dispatch(Action::Shell(ShellAction::ZoomOut));
        return true;
    }

    if ev.is_command('0') && !ev.mods.alt && !ev.mods.shift {
        s.dispatch(Action::Shell(ShellAction::ResetZoom));
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
        if handle_escape(s) {
            return true;
        }
        if matches!(s.window_mode, WindowMode::QuickChat | WindowMode::Utility) {
            tx.close_window();
            return true;
        }
        return false;
    }

    false
}

/// Dismisses the highest-precedence overlay, preview, or modal route cleanly.
pub fn handle_escape(s: &mut AppState) -> bool {
    if s.command_palette_open {
        super::palette::close_command_palette(s);
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
    if s.shell_ui.pending_trash_entry.is_some() {
        s.shell_ui.pending_trash_entry = None;
        return true;
    }
    if s.shell_ui.context_menu_thread_id.is_some() {
        s.shell_ui.context_menu_thread_id = None;
        s.shell_ui.context_menu_point = None;
        return true;
    }
    if s.shell_ui.file_context_menu.is_some() {
        s.shell_ui.file_context_menu = None;
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
    if s.shell_ui.renaming_file_key.is_some() {
        s.shell_ui.renaming_file_key = None;
        s.shell_ui.renaming_file_error = None;
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
    if s.shell_ui.left_overlay_open
        || s.shell_ui.right_overlay_open
        || (right_rail_uses_overlay(s) && is_right_overlay_visible(s))
    {
        s.shell_ui.left_overlay_open = false;
        s.shell_ui.right_overlay_open = false;
        if let Some(key) = active_canvas_target_key(s) {
            s.shell_ui.canvas_overlay_dismissed_key = Some(key);
        }
        return true;
    }
    if s.chat_ui.canvas.maximized {
        s.chat_ui.canvas.maximized = false;
        return true;
    }
    if s.active_file_preview.is_some() || s.canvas_document.is_some() {
        s.shell_ui.preview_maximized = false;
        if s.active_file_preview.is_some() {
            s.dispatch(Action::Shell(ShellAction::CloseFilePreview));
        }
        if s.canvas_document.is_some() {
            s.dispatch(Action::Chat(ChatAction::CloseCanvasDocument));
        }
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

    #[test]
    fn zoom_keyboard_shortcuts_adjust_and_reset_ui_scale() {
        let mut s = AppState::default();
        let initial = s.ui_scale;
        let mut tx = Tx::default();
        let cmd_mods = rune::Mods {
            cmd: true,
            ..Default::default()
        };

        let zoom_eq = KeyEvent {
            key: Key::Command('='),
            mods: cmd_mods,
        };
        assert!(handle_key(&mut s, &zoom_eq, &mut tx));
        assert!(s.ui_scale > initial);

        let after_eq = s.ui_scale;
        let zoom_plus = KeyEvent {
            key: Key::Command('+'),
            mods: rune::Mods {
                cmd: true,
                shift: true,
                ..Default::default()
            },
        };
        assert!(handle_key(&mut s, &zoom_plus, &mut tx));
        assert!(s.ui_scale > after_eq);

        let zoom_minus = KeyEvent {
            key: Key::Command('-'),
            mods: cmd_mods,
        };
        assert!(handle_key(&mut s, &zoom_minus, &mut tx));
        assert!((s.ui_scale - after_eq).abs() < 0.001);

        let zoom_zero = KeyEvent {
            key: Key::Command('0'),
            mods: cmd_mods,
        };
        assert!(handle_key(&mut s, &zoom_zero, &mut tx));
        assert!((s.ui_scale - crate::state::DEFAULT_UI_SCALE).abs() < 0.001);
    }

    #[test]
    fn escape_dismisses_compact_canvas_overlay_before_closing_preview() {
        let mut s = AppState::default();
        s.shell_ui.viewport_width = 900.0;
        s.feature_flags.insert("canvas".into(), true);
        s.active_file_preview = Some(crate::state::FilePreviewState {
            workspace_id: "ws-1".into(),
            path: "/tmp/ws-1/notes.md".into(),
            title: "notes.md".into(),
            content: Some("# Hello".into()),
            is_markdown: true,
            ..Default::default()
        });

        assert!(right_rail_uses_overlay(&s));
        assert!(is_right_overlay_visible(&s));

        assert!(handle_escape(&mut s));
        assert!(!is_right_overlay_visible(&s));
        assert!(s.active_file_preview.is_some());

        assert!(handle_escape(&mut s));
        assert!(s.active_file_preview.is_none());
    }

    #[test]
    fn command_palette_resets_query_on_close_and_reopen() {
        let mut s = AppState::default();
        let mut tx = Tx::default();
        let cmd_k = KeyEvent {
            key: Key::Command('k'),
            mods: rune::Mods {
                cmd: true,
                ..Default::default()
            },
        };

        assert!(handle_key(&mut s, &cmd_k, &mut tx));
        assert!(s.command_palette_open);

        s.command_palette_edit = rune::TextEdit::new("Zoom");
        s.dispatch(Action::Shell(ShellAction::SetCommandPaletteQuery(
            "Zoom".into(),
        )));
        s.shell_ui.command_palette_selected = 1;

        assert!(handle_escape(&mut s));
        assert!(!s.command_palette_open);
        assert!(s.command_palette_query.is_empty());
        assert!(s.command_palette_edit.text.is_empty());
        assert_eq!(s.shell_ui.command_palette_selected, 0);

        // Even if external callers left a stale query before Cmd+K open, opening clears it.
        s.command_palette_edit = rune::TextEdit::new("stale");
        s.command_palette_query = "stale".into();
        assert!(handle_key(&mut s, &cmd_k, &mut tx));
        assert!(s.command_palette_open);
        assert!(s.command_palette_query.is_empty());
        assert!(s.command_palette_edit.text.is_empty());
    }
}
