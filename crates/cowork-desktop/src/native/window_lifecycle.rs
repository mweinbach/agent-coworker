//! Window activation, reveal, close-confirmation coordination, and maximize recovery
//! matching `apps/desktop/electron/services/windowActivation.ts` and `windowCloseCoordinator.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use uuid::Uuid;

use crate::actions::{Action, ShellAction};
use crate::state::{AppState, ConfirmDialogRequest};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseDecision {
    AllowImmediate,
    PendingApproval { request_id: String },
}

#[derive(Clone, Debug)]
struct PendingClose {
    id: String,
    for_quit: bool,
}

/// Tracks coordinated close/quit approval checks across windows so dirty drafts or active runs
/// can prompt before closing without stalling permanently when responsive handlers decline or exit.
#[derive(Clone, Default)]
pub struct WindowCloseCoordinator {
    inner: Arc<Mutex<CloseCoordinatorInner>>,
}

#[derive(Default)]
struct CloseCoordinatorInner {
    pending_by_window: HashMap<String, PendingClose>,
    approved_once: HashMap<String, bool>,
    quitting: bool,
}

impl WindowCloseCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin_close(
        &self,
        window_key: &str,
        needs_confirmation: bool,
        for_quit: bool,
    ) -> CloseDecision {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.approved_once.remove(window_key).unwrap_or(false) || !needs_confirmation {
            return CloseDecision::AllowImmediate;
        }
        if for_quit {
            inner.quitting = true;
        }
        if let Some(existing) = inner.pending_by_window.get(window_key) {
            return CloseDecision::PendingApproval {
                request_id: existing.id.clone(),
            };
        }
        let id = Uuid::new_v4().to_string();
        inner.pending_by_window.insert(
            window_key.to_string(),
            PendingClose {
                id: id.clone(),
                for_quit,
            },
        );
        CloseDecision::PendingApproval { request_id: id }
    }

    /// Resolves an outstanding close confirmation; returns `(approved, for_quit)` if matched.
    pub fn resolve_close(
        &self,
        window_key: &str,
        request_id: &str,
        approved: bool,
    ) -> Option<bool> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let pending = inner.pending_by_window.get(window_key)?;
        if pending.id != request_id {
            return None;
        }
        let for_quit = pending.for_quit;
        inner.pending_by_window.remove(window_key);
        if approved {
            inner.approved_once.insert(window_key.to_string(), true);
        } else if for_quit {
            inner.quitting = false;
        }
        Some(for_quit)
    }

    pub fn is_quitting(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .quitting
    }

    pub fn clear_window(&self, window_key: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.pending_by_window.remove(window_key);
        inner.approved_once.remove(window_key);
    }
}

/// Reveals, un-minimizes, and focuses the main Rune window.
pub fn reveal_and_activate_main_window(handle: &rune::AppHandle<AppState>) {
    handle.open();
    handle.show();
    handle.focus();
}

static WINDOW_HANDLES: OnceLock<Mutex<HashMap<String, rune::WindowHandle>>> = OnceLock::new();

fn window_handle_map() -> &'static Mutex<HashMap<String, rune::WindowHandle>> {
    WINDOW_HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers a live `rune::WindowHandle` for bounds tracking and close-veto reveal.
pub fn register_window_handle(window_key: &str, handle: rune::WindowHandle) {
    let mut guard = window_handle_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.insert(window_key.to_string(), handle);
}

/// Removes a tracked window handle when closed permanently.
pub fn unregister_window_handle(window_key: &str) {
    let mut guard = window_handle_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.remove(window_key);
}

/// Returns the tracked `rune::WindowHandle` for `window_key` if registered.
pub fn get_window_handle(window_key: &str) -> Option<rune::WindowHandle> {
    let guard = window_handle_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.get(window_key).cloned()
}

/// Prefix used for confirm dialog IDs triggered by window close guards.
pub const WINDOW_CLOSE_CONFIRM_PREFIX: &str = "window-close:";

/// Returns true when the state holds unsent composer drafts, attachments, or busy/streaming turns.
pub fn has_unsaved_or_busy_work(state: &AppState) -> bool {
    if !state.composer_edit.text.trim().is_empty() {
        return true;
    }
    if state.composer_drafts.values().any(|draft| {
        !draft.text.trim().is_empty()
            || !draft.attachments.is_empty()
            || !draft.references.is_empty()
            || draft.submitting
    }) {
        return true;
    }
    if !state.pending_thread_messages.is_empty() {
        return true;
    }
    state.thread_runtime_by_id.values().any(|rt| {
        rt.streaming
            || rt.active_turn_id.is_some()
            || rt.pending_turn_count > 0
            || !rt.pending_interactions.is_empty()
    })
}

/// Builds a destructive confirmation dialog prompt for closing a dirty or busy window.
pub fn build_window_close_confirm_request(
    window_key: &str,
    request_id: &str,
) -> ConfirmDialogRequest {
    ConfirmDialogRequest {
        id: format!("{WINDOW_CLOSE_CONFIRM_PREFIX}{window_key}:{request_id}"),
        title: "Unsaved work in progress".to_string(),
        message: "You have unsent messages or an active response running. Closing now may interrupt or discard them.".to_string(),
        confirm_label: "Close Anyway".to_string(),
        cancel_label: "Keep Open".to_string(),
        destructive: true,
    }
}

/// Extracts `(window_key, request_id)` from a window-close confirmation dialog ID.
pub fn parse_window_close_confirm_id(dialog_id: &str) -> Option<(&str, &str)> {
    let rest = dialog_id.strip_prefix(WINDOW_CLOSE_CONFIRM_PREFIX)?;
    let (window_key, request_id) = rest.split_once(':')?;
    if window_key.is_empty() || request_id.is_empty() {
        return None;
    }
    Some((window_key, request_id))
}

/// Outcome of evaluating a window close request in Rune's `on_close`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WindowCloseOutcome {
    /// Allow the window to remain hidden/closed cleanly without quitting the process.
    AllowHideOnly,
    /// Allow close and initiate orderly process exit (non-macOS main window close or active quit).
    AllowQuit,
    /// Block/veto closing and display `dialog` in the window UI.
    PromptUser {
        request_id: String,
        dialog: ConfirmDialogRequest,
    },
}

/// Evaluates whether `window_key` can close cleanly or must reopen and prompt the user.
pub fn evaluate_window_close(
    coordinator: &WindowCloseCoordinator,
    window_key: &str,
    state: &AppState,
    already_quitting: bool,
    quit_on_main_close: bool,
) -> WindowCloseOutcome {
    if already_quitting {
        coordinator.clear_window(window_key);
        return if window_key == "main" {
            WindowCloseOutcome::AllowQuit
        } else {
            WindowCloseOutcome::AllowHideOnly
        };
    }

    let needs_confirmation = has_unsaved_or_busy_work(state);
    match coordinator.begin_close(window_key, needs_confirmation, false) {
        CloseDecision::AllowImmediate => {
            if window_key == "main" && quit_on_main_close {
                WindowCloseOutcome::AllowQuit
            } else {
                WindowCloseOutcome::AllowHideOnly
            }
        }
        CloseDecision::PendingApproval { request_id } => WindowCloseOutcome::PromptUser {
            dialog: build_window_close_confirm_request(window_key, &request_id),
            request_id,
        },
    }
}

/// Applies the outcome of a close request onto live Rune handles and state.
pub fn execute_window_close_hook(
    coordinator: &WindowCloseCoordinator,
    window_key: &str,
    state: &mut AppState,
    tx: &mut rune::Tx,
    app_handle: Option<&rune::AppHandle<AppState>>,
    flush_bounds: impl FnOnce(),
) {
    let outcome = evaluate_window_close(
        coordinator,
        window_key,
        state,
        rune::quitting(),
        !cfg!(target_os = "macos"),
    );
    match outcome {
        WindowCloseOutcome::AllowHideOnly => {
            flush_bounds();
        }
        WindowCloseOutcome::AllowQuit => {
            flush_bounds();
            if !rune::quitting() {
                tx.quit();
            }
        }
        WindowCloseOutcome::PromptUser { dialog, .. } => {
            if let Some(handle) = get_window_handle(window_key) {
                handle.open();
                handle.focus();
            } else if window_key == "main"
                && let Some(app) = app_handle
            {
                reveal_and_activate_main_window(app);
            }
            state.dispatch(Action::Shell(ShellAction::RequestConfirmDialog(dialog)));
        }
    }
}

/// Resolves a confirmed or cancelled close dialog on the UI thread when `handle.update(...)` runs.
pub fn complete_window_close_resolution(
    coordinator: &WindowCloseCoordinator,
    window_key: &str,
    request_id: &str,
    confirmed: bool,
    tx: &mut rune::Tx,
    flush_bounds: impl FnOnce(),
) -> bool {
    let Some(for_quit) = coordinator.resolve_close(window_key, request_id, confirmed) else {
        return false;
    };
    if !confirmed {
        return false;
    }
    flush_bounds();
    if for_quit || (window_key == "main" && !cfg!(target_os = "macos")) {
        tx.quit();
    } else if let Some(handle) = get_window_handle(window_key) {
        handle.hide();
    } else {
        tx.close_window();
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_coordinator_gates_dirty_close_and_resets_quit_on_cancel() {
        let coord = WindowCloseCoordinator::new();
        assert_eq!(
            coord.begin_close("main", false, false),
            CloseDecision::AllowImmediate
        );

        let CloseDecision::PendingApproval { request_id } = coord.begin_close("main", true, true)
        else {
            panic!("expected pending approval");
        };
        assert!(coord.is_quitting());

        assert_eq!(coord.resolve_close("main", &request_id, false), Some(true));
        assert!(!coord.is_quitting());

        let CloseDecision::PendingApproval { request_id: req2 } =
            coord.begin_close("main", true, false)
        else {
            panic!("expected second prompt");
        };
        assert_eq!(coord.resolve_close("main", &req2, true), Some(false));
        assert_eq!(
            coord.begin_close("main", true, false),
            CloseDecision::AllowImmediate
        );
    }

    #[test]
    fn evaluates_close_guard_for_dirty_drafts_and_busy_threads() {
        let mut state = AppState::default();
        assert!(!has_unsaved_or_busy_work(&state));

        let coord = WindowCloseCoordinator::new();
        assert_eq!(
            evaluate_window_close(&coord, "main", &state, false, false),
            WindowCloseOutcome::AllowHideOnly
        );
        assert_eq!(
            evaluate_window_close(&coord, "main", &state, false, true),
            WindowCloseOutcome::AllowQuit
        );

        // Unsaved composer text triggers prompt.
        state.composer_edit.text = "draft reply".to_string();
        assert!(has_unsaved_or_busy_work(&state));

        let WindowCloseOutcome::PromptUser { request_id, dialog } =
            evaluate_window_close(&coord, "main", &state, false, true)
        else {
            panic!("expected PromptUser when composer draft is non-empty");
        };
        assert_eq!(
            parse_window_close_confirm_id(&dialog.id),
            Some(("main", request_id.as_str()))
        );
        assert!(dialog.destructive);

        // User approves close -> one-shot allow passes on next close attempt.
        assert_eq!(coord.resolve_close("main", &request_id, true), Some(false));
        assert_eq!(
            evaluate_window_close(&coord, "main", &state, false, false),
            WindowCloseOutcome::AllowHideOnly
        );

        // Active quit bypasses confirmation even with busy work.
        let mut busy_state = AppState::default();
        busy_state.thread_runtime_by_id.insert(
            "t-1".to_string(),
            crate::state::ThreadRuntime {
                streaming: true,
                ..Default::default()
            },
        );
        assert!(has_unsaved_or_busy_work(&busy_state));
        assert_eq!(
            evaluate_window_close(&coord, "main", &busy_state, true, false),
            WindowCloseOutcome::AllowQuit
        );
        assert_eq!(
            evaluate_window_close(&coord, "quick-chat", &busy_state, true, true),
            WindowCloseOutcome::AllowHideOnly
        );
    }
}
