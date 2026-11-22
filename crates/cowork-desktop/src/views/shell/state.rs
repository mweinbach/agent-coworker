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

/// Duration window keeping split pane spring motion and closing pane content mounted.
pub(crate) const PANE_ANIM_DURATION_SECS: f64 = 0.35;

/// Deadline tracking an active split pane open/collapse spring using simulated `app_elapsed_secs`
/// when available (live app & benchmarks) or wall-clock `Instant` in headless `Runtime` tests.
#[derive(Clone, Copy, Debug)]
pub enum PaneAnimDeadline {
    ElapsedSecs(f64),
    WallClock(std::time::Instant),
}

impl PaneAnimDeadline {
    pub(crate) fn after(app_elapsed_secs: f64, duration_secs: f64) -> Self {
        if app_elapsed_secs > 0.0 {
            Self::ElapsedSecs(app_elapsed_secs + duration_secs)
        } else {
            Self::WallClock(
                std::time::Instant::now() + std::time::Duration::from_secs_f64(duration_secs),
            )
        }
    }

    pub(crate) fn is_active(self, app_elapsed_secs: f64) -> bool {
        match self {
            Self::ElapsedSecs(until) => app_elapsed_secs < until,
            Self::WallClock(until) => std::time::Instant::now() < until,
        }
    }
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
    pub onboarding_expanded_provider: Option<String>,
    pub onboarding_api_key_edit: TextEdit,
    pub onboarding_api_key_revealed: bool,
    pub onboarding_oauth_code_edit: TextEdit,
    pub onboarding_lmstudio_url_edit: TextEdit,
    pub onboarding_open_select: Option<String>,
    pub onboarding_completion_error: Option<String>,
    pub selected_workflow_run_id: Option<String>,
    pub task_create_open: bool,
    pub task_create_submitting: bool,
    pub task_create_title_edit: TextEdit,
    pub task_create_objective_edit: TextEdit,
    pub task_create_idempotency_key: Option<(String, String)>,
    pub task_feedback_open_task: Option<(String, String)>,
    pub task_feedback_submitting_tasks: HashSet<(String, String)>,
    pub task_feedback_edits: HashMap<(String, String), TextEdit>,
    pub task_question_dialog_open: bool,
    pub task_question_reply_edits: HashMap<(String, String), TextEdit>,
    pub task_question_answers: HashMap<(String, String), String>,
    pub task_work_graph_collapsed: bool,
    pub task_conversation_open: bool,
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
    pub sidebar_resize_start_width: Option<f32>,
    pub inspector_resize_start_width: Option<f32>,
    pub sidebar_last_rendered_open: bool,
    pub inspector_last_rendered_open: bool,
    pub sidebar_anim_until: Option<PaneAnimDeadline>,
    pub inspector_anim_until: Option<PaneAnimDeadline>,
    pub last_route_view: Option<ViewId>,
    pub sidebar_reorder_rev: u64,
    pub menu_bar: super::menu_bar::MenuBarUiState,
}

impl ShellUiState {
    pub fn reset_onboarding_transient(&mut self) {
        self.onboarding_step = 0;
        self.onboarding_confirm_discard = false;
        self.onboarding_expanded_provider = None;
        self.onboarding_api_key_edit = TextEdit::new("");
        self.onboarding_api_key_revealed = false;
        self.onboarding_oauth_code_edit = TextEdit::new("");
        self.onboarding_lmstudio_url_edit = TextEdit::new("");
        self.onboarding_open_select = None;
        self.onboarding_completion_error = None;
    }

    pub fn ensure_task_create_idempotency_key(&mut self, workspace_id: &str) -> String {
        if let Some((ws_id, key)) = self.task_create_idempotency_key.as_ref()
            && ws_id == workspace_id
            && !key.trim().is_empty()
        {
            return key.clone();
        }
        let fresh = uuid::Uuid::new_v4().to_string();
        self.task_create_idempotency_key = Some((workspace_id.to_owned(), fresh.clone()));
        fresh
    }

    pub fn reset_task_create_draft(&mut self) {
        self.task_create_open = false;
        self.task_create_submitting = false;
        self.task_create_title_edit = TextEdit::new("");
        self.task_create_objective_edit = TextEdit::new("");
        self.task_create_idempotency_key = None;
    }

    pub fn is_task_feedback_open(&self, workspace_id: &str, task_id: &str) -> bool {
        self.task_feedback_open_task
            .as_ref()
            .is_some_and(|(ws, tid)| ws == workspace_id && tid == task_id)
    }

    pub fn is_task_feedback_submitting(&self, workspace_id: &str, task_id: &str) -> bool {
        self.task_feedback_submitting_tasks
            .contains(&(workspace_id.to_owned(), task_id.to_owned()))
    }

    pub fn task_feedback_edit(&self, workspace_id: &str, task_id: &str) -> Option<&TextEdit> {
        self.task_feedback_edits
            .get(&(workspace_id.to_owned(), task_id.to_owned()))
    }

    pub fn task_feedback_edit_mut(&mut self, workspace_id: &str, task_id: &str) -> &mut TextEdit {
        self.task_feedback_edits
            .entry((workspace_id.to_owned(), task_id.to_owned()))
            .or_insert_with(|| TextEdit::new(""))
    }

    pub fn open_task_feedback(&mut self, workspace_id: &str, task_id: &str) {
        if let Some(prev) = self.task_feedback_open_task.as_ref()
            && let Some(prev_edit) = self.task_feedback_edits.get_mut(prev)
        {
            prev_edit.focused = false;
        }
        let key = (workspace_id.to_owned(), task_id.to_owned());
        self.task_feedback_open_task = Some(key.clone());
        self.task_feedback_edits
            .entry(key)
            .or_insert_with(|| TextEdit::new(""))
            .focused = true;
    }

    pub fn toggle_task_feedback(&mut self, workspace_id: &str, task_id: &str) {
        if self.is_task_feedback_open(workspace_id, task_id) {
            self.close_task_feedback_for(workspace_id, task_id);
        } else {
            self.open_task_feedback(workspace_id, task_id);
        }
    }

    pub fn close_task_feedback_for(&mut self, workspace_id: &str, task_id: &str) {
        if self.is_task_feedback_open(workspace_id, task_id) {
            self.task_feedback_open_task = None;
        }
        if let Some(edit) = self
            .task_feedback_edits
            .get_mut(&(workspace_id.to_owned(), task_id.to_owned()))
        {
            edit.focused = false;
        }
    }

    pub fn clear_task_feedback(&mut self, workspace_id: &str, task_id: &str) {
        self.close_task_feedback_for(workspace_id, task_id);
        let key = (workspace_id.to_owned(), task_id.to_owned());
        self.task_feedback_submitting_tasks.remove(&key);
        self.task_feedback_edits.remove(&key);
    }

    pub fn prune_task_feedback_for_workspace(&mut self, workspace_id: &str) {
        if self
            .task_feedback_open_task
            .as_ref()
            .is_some_and(|(ws, _)| ws == workspace_id)
        {
            self.task_feedback_open_task = None;
        }
        self.task_feedback_submitting_tasks
            .retain(|(ws, _)| ws != workspace_id);
        self.task_feedback_edits
            .retain(|(ws, _), _| ws != workspace_id);
    }
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
            onboarding_expanded_provider: None,
            onboarding_api_key_edit: TextEdit::new(""),
            onboarding_api_key_revealed: false,
            onboarding_oauth_code_edit: TextEdit::new(""),
            onboarding_lmstudio_url_edit: TextEdit::new(""),
            onboarding_open_select: None,
            onboarding_completion_error: None,
            selected_workflow_run_id: None,
            task_create_open: false,
            task_create_submitting: false,
            task_create_title_edit: TextEdit::new(""),
            task_create_objective_edit: TextEdit::new(""),
            task_create_idempotency_key: None,
            task_feedback_open_task: None,
            task_feedback_submitting_tasks: HashSet::new(),
            task_feedback_edits: HashMap::new(),
            task_question_dialog_open: false,
            task_question_reply_edits: HashMap::new(),
            task_question_answers: HashMap::new(),
            task_work_graph_collapsed: false,
            task_conversation_open: false,
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
            sidebar_resize_start_width: None,
            inspector_resize_start_width: None,
            sidebar_last_rendered_open: true,
            inspector_last_rendered_open: false,
            sidebar_anim_until: None,
            inspector_anim_until: None,
            last_route_view: None,
            sidebar_reorder_rev: 0,
            menu_bar: super::menu_bar::MenuBarUiState::default(),
        }
    }
}

/// Zero-allocation reference to the active Canvas target key for hot layout and view paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActiveCanvasKeyRef<'a> {
    Fixture {
        workspace_id: &'a str,
        path: &'a str,
    },
    Session {
        workspace_id: &'a str,
        document_id: &'a str,
        generation: u64,
    },
    Preview {
        workspace_id: &'a str,
        path: &'a str,
    },
}

impl ActiveCanvasKeyRef<'_> {
    pub(crate) fn matches_stored(self, stored: Option<&str>) -> bool {
        let Some(stored) = stored else {
            return false;
        };
        match self {
            Self::Fixture { workspace_id, path } => {
                stored
                    .strip_prefix("fixture:")
                    .and_then(|rest| rest.strip_prefix(workspace_id))
                    .and_then(|rest| rest.strip_prefix(':'))
                    == Some(path)
            }
            Self::Preview { workspace_id, path } => {
                stored
                    .strip_prefix("preview:")
                    .and_then(|rest| rest.strip_prefix(workspace_id))
                    .and_then(|rest| rest.strip_prefix(':'))
                    == Some(path)
            }
            Self::Session {
                workspace_id,
                document_id,
                generation,
            } => {
                stored
                    .strip_prefix("session:")
                    .and_then(|rest| rest.strip_prefix(workspace_id))
                    .and_then(|rest| rest.strip_prefix(':'))
                    .and_then(|rest| rest.strip_prefix(document_id))
                    .and_then(|rest| rest.strip_prefix(':'))
                    .and_then(|gen_str| gen_str.parse::<u64>().ok())
                    == Some(generation)
            }
        }
    }

    pub(crate) fn to_owned_key(self) -> String {
        match self {
            Self::Fixture { workspace_id, path } => format!("fixture:{workspace_id}:{path}"),
            Self::Session {
                workspace_id,
                document_id,
                generation,
            } => format!("session:{workspace_id}:{document_id}:{generation}"),
            Self::Preview { workspace_id, path } => format!("preview:{workspace_id}:{path}"),
        }
    }
}

/// Returns a borrowed key for the active Canvas session without allocating.
pub(crate) fn active_canvas_target_key_ref(s: &AppState) -> Option<ActiveCanvasKeyRef<'_>> {
    if let Some(ref fx) = s.chat_ui.canvas.fixture {
        return Some(ActiveCanvasKeyRef::Fixture {
            workspace_id: fx.workspace_id.as_str(),
            path: fx.path.as_str(),
        });
    }
    if !s.feature_flags.get("canvas").copied().unwrap_or(false) {
        return None;
    }
    if let Some(ref doc) = s.canvas_document {
        return Some(ActiveCanvasKeyRef::Session {
            workspace_id: doc.workspace_id.as_str(),
            document_id: doc.document_id.as_str(),
            generation: doc.generation,
        });
    }
    let preview = s.active_file_preview.as_ref()?;
    if preview.is_binary {
        return None;
    }
    crate::views::chat::canvas::classify_canvas_path(&preview.path)?;
    Some(ActiveCanvasKeyRef::Preview {
        workspace_id: preview.workspace_id.as_str(),
        path: preview.path.as_str(),
    })
}

/// Returns `true` when Canvas currently handles the right rail (zero allocations).
pub(crate) fn has_active_canvas_target(s: &AppState) -> bool {
    active_canvas_target_key_ref(s).is_some()
}

/// Returns a stable key for the active Canvas session when Canvas handles the right rail.
pub(crate) fn active_canvas_target_key(s: &AppState) -> Option<String> {
    active_canvas_target_key_ref(s).map(ActiveCanvasKeyRef::to_owned_key)
}

/// True when the active right rail (`Context`, `Task`, or `Canvas`) renders as an overlay drawer.
pub(crate) fn right_rail_uses_overlay(s: &AppState) -> bool {
    let uses_wide_overlay = has_active_canvas_target(s) || s.route().view == ViewId::Task;
    s.shell_ui.viewport_width < super::helpers::NARROW_BREAKPOINT
        || (uses_wide_overlay && s.shell_ui.viewport_width < super::helpers::FULL_BREAKPOINT)
}

/// True when the compact/narrow right overlay drawer should be visible.
pub(crate) fn is_right_overlay_visible(s: &AppState) -> bool {
    if let Some(key_ref) = active_canvas_target_key_ref(s) {
        s.shell_ui.right_overlay_open
            || !key_ref.matches_stored(s.shell_ui.canvas_overlay_dismissed_key.as_deref())
    } else {
        s.shell_ui.right_overlay_open
    }
}

/// Toggles the right inspector / Canvas rail, exiting Canvas maximized mode cleanly when active.
pub(crate) fn toggle_right_inspector(s: &mut AppState) {
    let canvas_active = has_active_canvas_target(s);
    if canvas_active && s.chat_ui.canvas.maximized {
        s.chat_ui.canvas.maximized = false;
        if right_rail_uses_overlay(s) {
            s.shell_ui.right_overlay_open = false;
            s.shell_ui.canvas_overlay_dismissed_key = active_canvas_target_key(s);
        } else {
            s.shell_ui.canvas_pane.set_open(false);
        }
        return;
    }
    if right_rail_uses_overlay(s) {
        let next_open = !is_right_overlay_visible(s);
        s.shell_ui.right_overlay_open = next_open;
        if next_open {
            s.shell_ui.left_overlay_open = false;
            s.shell_ui.canvas_overlay_dismissed_key = None;
        } else {
            s.shell_ui.canvas_overlay_dismissed_key = active_canvas_target_key(s);
        }
    } else if canvas_active {
        s.shell_ui.canvas_pane.toggle();
    } else {
        s.dispatch(Action::Shell(ShellAction::ToggleContextSidebar));
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
            .field("menu_bar", &self.menu_bar)
            .finish()
    }
}

fn is_active_task_feedback_open(s: &AppState) -> bool {
    s.route().view == ViewId::Task
        && s.active_task.as_ref().is_some_and(|task| {
            s.shell_ui
                .is_task_feedback_open(&task.summary.workspace_id, &task.summary.id)
        })
}

/// True when a blocking modal, dialog, onboarding step, or popup overlay (excluding the
/// application menu bar) is currently active.
pub(crate) fn any_non_menu_overlay_open(s: &AppState) -> bool {
    s.command_palette_open
        || s.shell_ui.search_overlay_open
        || super::overlays::is_onboarding_visible(s)
        || s.lmstudio_start_modal.is_some()
        || s.pending_external_url.is_some()
        || s.pending_confirm_dialog.is_some()
        || s.shell_ui.pending_delete_thread_id.is_some()
        || s.shell_ui.pending_trash_entry.is_some()
        || s.shell_ui.selected_workflow_run_id.is_some()
        || s.shell_ui.context_menu_thread_id.is_some()
        || s.shell_ui.file_context_menu.is_some()
        || s.shell_ui.usage_popover_open
        || s.shell_ui.task_question_dialog_open
        || is_active_task_feedback_open(s)
        || s.shell_ui.task_create_open
        || s.shell_ui.onboarding_confirm_discard
        || s.agent_viewer.is_some()
        || s.chat_ui.cancel_subagents_open
}

/// Global keyboard dispatcher for shell shortcuts (`Cmd/Ctrl+K`, `Cmd/Ctrl+Shift+B`, `Cmd/Ctrl+.`, `Escape`).
pub fn handle_key(s: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    let handled = handle_key_inner(s, ev, tx);
    s.take_navigation_settle(tx);
    handled
}

fn handle_key_inner(s: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    if rune_kit::shell::is_sidebar_toggle(ev)
        || (ev.is_command('b') && !ev.mods.shift && !ev.mods.alt)
    {
        if s.shell_ui.menu_bar.is_active() || s.shell_ui.menu_bar.temp_revealed {
            super::menu_bar::dismiss_menu_bar(s, tx, false);
        }
        if s.shell_ui.viewport_width < super::helpers::NARROW_BREAKPOINT {
            if s.route().view == ViewId::Settings {
                s.settings_ui.mobile_nav_open = !s.settings_ui.mobile_nav_open;
                if s.settings_ui.mobile_nav_open {
                    s.shell_ui.right_overlay_open = false;
                }
            } else {
                s.shell_ui.left_overlay_open = !s.shell_ui.left_overlay_open;
                if s.shell_ui.left_overlay_open {
                    s.shell_ui.right_overlay_open = false;
                }
            }
        } else if s.route().view != ViewId::Settings {
            s.dispatch(Action::Shell(ShellAction::ToggleSidebar));
        }
        return true;
    }

    if ev.is_command('k') && !ev.mods.alt && !ev.mods.shift {
        if s.shell_ui.menu_bar.is_active() || s.shell_ui.menu_bar.temp_revealed {
            super::menu_bar::dismiss_menu_bar(s, tx, false);
        }
        super::palette::toggle_command_palette(s);
        return true;
    }

    if ev.is_command('f') && ev.mods.shift && !ev.mods.alt {
        if s.shell_ui.menu_bar.is_active() || s.shell_ui.menu_bar.temp_revealed {
            super::menu_bar::dismiss_menu_bar(s, tx, false);
        }
        let opening = !s.shell_ui.search_overlay_open;
        s.shell_ui.search_overlay_open = opening;
        s.shell_ui.search_selected = 0;
        s.shell_ui.search_edit.focused = opening;
        return true;
    }

    if s.command_palette_open {
        match ev.key {
            Key::Up => {
                s.shell_ui.command_palette_selected =
                    s.shell_ui.command_palette_selected.saturating_sub(1);
                return true;
            }
            Key::Down => {
                let query = s.command_palette_query.trim().to_lowercase();
                let items = super::palette::collect_palette_items(s, &query);
                if !items.is_empty() {
                    let max_idx = items.len().saturating_sub(1);
                    s.shell_ui.command_palette_selected =
                        (s.shell_ui.command_palette_selected + 1).min(max_idx);
                }
                return true;
            }
            Key::Enter => {
                let query = s.command_palette_query.trim().to_lowercase();
                let items = super::palette::collect_palette_items(s, &query);
                let max_idx = items.len().saturating_sub(1);
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
        let quick_slot = if !ev.mods.alt && !ev.mods.shift {
            ['1', '2', '3', '4', '5', '6', '7', '8', '9']
                .into_iter()
                .position(|digit| ev.is_command(digit))
        } else {
            None
        };
        if let Some(slot) = quick_slot {
            let items = super::overlays::collect_search_overlay_items(s);
            if let Some(item) = items.get(slot) {
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
                let items = super::overlays::collect_search_overlay_items(s);
                if !items.is_empty() {
                    let max_idx = items.len().saturating_sub(1);
                    s.shell_ui.search_selected = (s.shell_ui.search_selected + 1).min(max_idx);
                }
                return true;
            }
            Key::Enter => {
                let items = super::overlays::collect_search_overlay_items(s);
                let max_idx = items.len().saturating_sub(1);
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
        toggle_right_inspector(s);
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

    if super::menu_bar::handle_key(s, ev, tx) {
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

    if route_active_presentation_key(s, ev, tx) {
        return true;
    }

    false
}

fn has_blocking_overlay_or_focused_input(s: &AppState) -> bool {
    s.command_palette_open
        || s.shell_ui.search_overlay_open
        || super::overlays::is_onboarding_visible(s)
        || s.lmstudio_start_modal.is_some()
        || s.pending_external_url.is_some()
        || s.pending_confirm_dialog.is_some()
        || s.shell_ui.pending_delete_thread_id.is_some()
        || s.shell_ui.pending_trash_entry.is_some()
        || s.shell_ui.selected_workflow_run_id.is_some()
        || s.shell_ui.context_menu_thread_id.is_some()
        || s.shell_ui.file_context_menu.is_some()
        || s.shell_ui.usage_popover_open
        || s.shell_ui.task_question_dialog_open
        || is_active_task_feedback_open(s)
        || s.shell_ui.task_create_open
        || s.shell_ui.renaming_thread_id.is_some()
        || s.shell_ui.renaming_file_key.is_some()
        || s.shell_ui.left_overlay_open
        || (s.route().view == ViewId::Settings && s.settings_ui.mobile_nav_open)
        || s.shell_ui.right_overlay_open
        || s.shell_ui.onboarding_confirm_discard
        || s.agent_viewer.is_some()
        || s.chat_ui.cancel_subagents_open
        || s.chat_ui.reasoning_open
        || s.chat_ui.landing_target_open
        || s.chat_ui.model_combobox.is_open()
        || s.chat_ui.model_picker_search.focused
        || s.chat_ui.active_citation_popover.is_some()
        || s.chat_ui.active_mention_popover.is_some()
        || s.composer_edit.focused
        || s.sidebar_search_edit.focused
        || s.command_palette_edit.focused
        || s.shell_ui.search_edit.focused
        || s.shell_ui.rename_edit.focused
        || s.shell_ui.renaming_file_edit.focused
        || s.shell_ui.task_create_title_edit.focused
        || s.shell_ui.task_create_objective_edit.focused
        || s.active_task.as_ref().is_some_and(|task| {
            s.shell_ui
                .task_feedback_edit(&task.summary.workspace_id, &task.summary.id)
                .is_some_and(|e| e.focused)
        })
        || s.shell_ui
            .task_question_reply_edits
            .values()
            .any(|e| e.focused)
        || s.chat_ui.canvas.source_edit.focused
        || s.chat_ui.canvas.prompt_edit.focused
        || s.chat_ui.ask_text_edits.values().any(|e| e.focused)
}

fn is_inline_presentation_preview_visible(s: &AppState) -> bool {
    if s.window_mode != WindowMode::Main || s.route().view == ViewId::Settings {
        return false;
    }
    if let Some(ws_id) = s.active_workspace_id.as_deref()
        && let Some(rt) = s.workspace_runtime_by_id.get(ws_id)
        && !matches!(
            rt.server_state,
            crate::state::ServerLifecycleState::Running { .. }
        )
    {
        return false;
    }
    !has_active_canvas_target(s)
}

fn route_active_presentation_key(s: &mut AppState, ev: &KeyEvent, tx: &Tx) -> bool {
    if ev.mods.cmd || ev.mods.ctrl || ev.mods.alt {
        return false;
    }
    // `pptx-preview-root`'s `.on_key` handles slide navigation directly when focus is inside the deck.
    if tx
        .focused()
        .is_some_and(|key| key == "pptx-preview-root" || key.starts_with("pptx-"))
    {
        return false;
    }
    if has_blocking_overlay_or_focused_input(s) || !is_inline_presentation_preview_visible(s) {
        return false;
    }
    let Some(preview) = s.active_file_preview.as_ref() else {
        return false;
    };
    if preview.error.is_some() {
        return false;
    }
    let Some(presentation) = preview.presentation.as_deref() else {
        return false;
    };
    if presentation.loading
        || presentation.error_message.is_some()
        || presentation.slides.is_empty()
    {
        return false;
    }
    s.preview_ui
        .handle_presentation_key(&ev.key, presentation.slides.len())
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
    if is_active_task_feedback_open(s)
        && let Some((ws_id, task_id)) = s.shell_ui.task_feedback_open_task.clone()
    {
        s.shell_ui.close_task_feedback_for(&ws_id, &task_id);
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
    if s.shell_ui.onboarding_open_select.is_some() {
        s.shell_ui.onboarding_open_select = None;
        return true;
    }
    if s.shell_ui.onboarding_confirm_discard {
        s.shell_ui.onboarding_confirm_discard = false;
        return true;
    }
    if s.shell_ui.left_overlay_open
        || (s.route().view == ViewId::Settings && s.settings_ui.mobile_nav_open)
        || s.shell_ui.right_overlay_open
        || (right_rail_uses_overlay(s) && is_right_overlay_visible(s))
    {
        s.shell_ui.left_overlay_open = false;
        s.settings_ui.mobile_nav_open = false;
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
    if super::overlays::is_onboarding_visible(s) {
        super::onboarding::request_dismiss_onboarding(s);
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

    fn presentation_preview_state() -> AppState {
        use crate::views::preview::{PresentationPreviewData, PresentationSlideData};

        let mut s = AppState::default();
        s.onboarding.completed = true;
        s.active_file_preview = Some(crate::state::FilePreviewState {
            workspace_id: "ws-1".into(),
            path: "/tmp/ws-1/deck.pptx".into(),
            title: "deck.pptx".into(),
            is_binary: true,
            presentation: Some(Box::new(PresentationPreviewData {
                loading: false,
                slides: (0..3)
                    .map(|idx| PresentationSlideData {
                        slide_index: idx,
                        slide_id: Some(format!("s-{idx}")),
                        title: Some(format!("Slide {}", idx + 1)),
                        png_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=".into(),
                    })
                    .collect(),
                rendering_mode: Some("rendered".into()),
                ..Default::default()
            })),
            ..Default::default()
        });
        s
    }

    #[test]
    fn handle_key_routes_presentation_navigation_unless_overlay_or_input_focused() {
        let mut s = presentation_preview_state();
        let mut tx = Tx::default();
        let right = KeyEvent {
            key: Key::Right,
            mods: rune::Mods::default(),
        };
        let left = KeyEvent {
            key: Key::Left,
            mods: rune::Mods::default(),
        };
        let end = KeyEvent {
            key: Key::End,
            mods: rune::Mods::default(),
        };
        let home = KeyEvent {
            key: Key::Home,
            mods: rune::Mods::default(),
        };
        let cmd_right = KeyEvent {
            key: Key::Right,
            mods: rune::Mods {
                cmd: true,
                ..Default::default()
            },
        };

        assert!(handle_key(&mut s, &right, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 1);

        assert!(handle_key(&mut s, &end, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 2);

        assert!(handle_key(&mut s, &left, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 1);

        assert!(handle_key(&mut s, &home, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 0);

        assert!(!handle_key(&mut s, &cmd_right, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 0);

        // Focused text input must block slide routing.
        s.composer_edit.focused = true;
        assert!(!handle_key(&mut s, &right, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 0);
        s.composer_edit.focused = false;

        // Open overlay/dialog/onboarding must block slide routing.
        s.command_palette_open = true;
        assert!(!handle_key(&mut s, &right, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 0);
        s.command_palette_open = false;

        s.pending_confirm_dialog = Some(ConfirmDialogRequest {
            id: "c1".into(),
            title: "Confirm".into(),
            message: "Proceed?".into(),
            confirm_label: "Yes".into(),
            cancel_label: "No".into(),
            destructive: false,
        });
        assert!(!handle_key(&mut s, &right, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 0);
        s.pending_confirm_dialog = None;

        s.onboarding.completed = false;
        assert!(!handle_key(&mut s, &right, &mut tx));
        assert_eq!(s.preview_ui.active_slide, 0);
    }
}
