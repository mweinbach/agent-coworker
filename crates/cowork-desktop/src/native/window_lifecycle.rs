//! Window activation, reveal, close-confirmation coordination, and maximize recovery
//! matching `apps/desktop/electron/services/windowActivation.ts` and `windowCloseCoordinator.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use uuid::Uuid;

use crate::actions::StoreEvent;
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
        if let Some(existing) = inner.pending_by_window.get_mut(window_key) {
            if for_quit {
                existing.for_quit = true;
            }
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

/// Returns true when closing the window risks losing unsent drafts, active turns, or dirty Canvas edits.
pub fn has_unsaved_or_busy_work(state: &AppState) -> bool {
    state.has_unsaved_or_busy_work()
}

/// Decides whether a user-initiated native window close needs unsaved-work consent.
pub fn close_request_decision(state: &AppState) -> rune::CloseResponse {
    if has_unsaved_or_busy_work(state) {
        rune::CloseResponse::Defer
    } else {
        rune::CloseResponse::Close
    }
}

/// Decides whether an OS-initiated app quit needs unsaved-work consent.
pub fn quit_request_decision(state: &AppState) -> rune::QuitResponse {
    if has_unsaved_or_busy_work(state) {
        rune::QuitResponse::Defer
    } else {
        rune::QuitResponse::Quit
    }
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

/// Builds a destructive confirmation dialog prompt for quitting while dirty or busy.
pub fn build_app_quit_confirm_request(request_id: &str) -> ConfirmDialogRequest {
    ConfirmDialogRequest {
        id: format!("{WINDOW_CLOSE_CONFIRM_PREFIX}main:{request_id}"),
        title: "Unsaved work in progress".to_string(),
        message: "You have unsent messages or an active response running. Quitting now may interrupt or discard them.".to_string(),
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

    // Secondary windows ("quick-chat", "utility") only hide while the main window keeps
    // workspace drafts, active turns, and Canvas state open.
    if window_key != "main" {
        coordinator.clear_window(window_key);
        return WindowCloseOutcome::AllowHideOnly;
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

/// Evaluates whether an explicit app quit can proceed immediately or must prompt the user.
pub fn evaluate_app_quit(
    coordinator: &WindowCloseCoordinator,
    state: &AppState,
    already_quitting: bool,
) -> WindowCloseOutcome {
    if already_quitting {
        coordinator.clear_window("main");
        return WindowCloseOutcome::AllowQuit;
    }

    let needs_confirmation = has_unsaved_or_busy_work(state);
    match coordinator.begin_close("main", needs_confirmation, true) {
        CloseDecision::AllowImmediate => WindowCloseOutcome::AllowQuit,
        CloseDecision::PendingApproval { request_id } => WindowCloseOutcome::PromptUser {
            dialog: build_app_quit_confirm_request(&request_id),
            request_id,
        },
    }
}

/// Applies the outcome of an explicit app quit request onto live Rune handles and state.
pub fn execute_app_quit_hook(
    coordinator: &WindowCloseCoordinator,
    state: &mut AppState,
    tx: &mut rune::Tx,
    app_handle: Option<&rune::AppHandle<AppState>>,
    flush_bounds: impl FnOnce(),
) {
    let outcome = evaluate_app_quit(coordinator, state, rune::quitting());
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
        WindowCloseOutcome::PromptUser { request_id, dialog } => {
            if let Some(handle) = get_window_handle("main") {
                handle.open();
                handle.focus();
            } else if let Some(app) = app_handle {
                reveal_and_activate_main_window(app);
            }
            state.apply_store_event(StoreEvent::ConfirmWindowClose {
                window_id: "main".to_string(),
                request_id,
                title: dialog.title,
                message: dialog.message,
            });
        }
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
        WindowCloseOutcome::PromptUser { request_id, dialog } => {
            if let Some(handle) = get_window_handle(window_key) {
                handle.open();
                handle.focus();
            } else if window_key == "main"
                && let Some(app) = app_handle
            {
                reveal_and_activate_main_window(app);
            }
            state.apply_store_event(StoreEvent::ConfirmWindowClose {
                window_id: window_key.to_string(),
                request_id,
                title: dialog.title,
                message: dialog.message,
            });
        }
    }
}

/// Pure UI action planned after a user resolves a dirty/busy close prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowCloseResolutionAction {
    Ignore,
    Quit,
    HideWindow,
    CloseCurrentWindow,
}

/// Resolves an outstanding close prompt and updates `coordinator` before applying the UI action.
pub fn plan_window_close_resolution(
    coordinator: &WindowCloseCoordinator,
    window_key: &str,
    request_id: &str,
    confirmed: bool,
    has_registered_handle: bool,
    quit_on_main_close: bool,
) -> WindowCloseResolutionAction {
    let Some(for_quit) = coordinator.resolve_close(window_key, request_id, confirmed) else {
        return WindowCloseResolutionAction::Ignore;
    };
    if !confirmed {
        return WindowCloseResolutionAction::Ignore;
    }
    if for_quit || (window_key == "main" && quit_on_main_close) {
        coordinator.clear_window(window_key);
        WindowCloseResolutionAction::Quit
    } else if has_registered_handle {
        // `handle.hide()` skips `on_close`, so clear the one-shot approval here or subsequent
        // reopen -> dirty close attempts would bypass confirmation.
        coordinator.clear_window(window_key);
        WindowCloseResolutionAction::HideWindow
    } else {
        WindowCloseResolutionAction::CloseCurrentWindow
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
    let handle = get_window_handle(window_key);
    let action = plan_window_close_resolution(
        coordinator,
        window_key,
        request_id,
        confirmed,
        handle.is_some(),
        !cfg!(target_os = "macos"),
    );
    match action {
        WindowCloseResolutionAction::Ignore => false,
        WindowCloseResolutionAction::Quit => {
            flush_bounds();
            tx.quit();
            true
        }
        WindowCloseResolutionAction::HideWindow => {
            flush_bounds();
            if let Some(handle) = handle {
                handle.hide();
            }
            true
        }
        WindowCloseResolutionAction::CloseCurrentWindow => {
            flush_bounds();
            tx.close_window();
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_close_and_quit_requests_defer_for_dirty_work() {
        let mut state = AppState::default();
        assert_eq!(close_request_decision(&state), rune::CloseResponse::Close);
        assert_eq!(quit_request_decision(&state), rune::QuitResponse::Quit);

        state.composer_edit.text = "unsent draft".to_string();
        assert_eq!(close_request_decision(&state), rune::CloseResponse::Defer);
        assert_eq!(quit_request_decision(&state), rune::QuitResponse::Defer);
    }

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

        // Dirty chat canvas UI also triggers the close guard for the main window, while secondary
        // hide-only windows ("quick-chat", "utility") always hide without prompting.
        let mut dirty_canvas = AppState::default();
        dirty_canvas.chat_ui.canvas.sync_session(
            "ws:notes.md",
            "ws:notes.md:gen1",
            1,
            "before",
            "before",
            true,
            false,
            false,
        );
        dirty_canvas
            .chat_ui
            .canvas
            .source_edit
            .replace_text("after");
        assert!(has_unsaved_or_busy_work(&dirty_canvas));
        assert!(matches!(
            evaluate_window_close(&coord, "main", &dirty_canvas, false, false),
            WindowCloseOutcome::PromptUser { .. }
        ));
        assert_eq!(
            evaluate_window_close(&coord, "quick-chat", &dirty_canvas, false, false),
            WindowCloseOutcome::AllowHideOnly
        );
        assert_eq!(
            evaluate_window_close(&coord, "utility", &dirty_canvas, false, true),
            WindowCloseOutcome::AllowHideOnly
        );
    }

    #[test]
    fn second_dirty_close_prompts_again_after_approved_hide() {
        let coord = WindowCloseCoordinator::new();
        let mut dirty = AppState::default();
        dirty.composer_edit.text = "unsaved draft".to_string();

        // First dirty close prompts user; approving hide on macOS clears approved_once immediately.
        let WindowCloseOutcome::PromptUser {
            request_id: req1, ..
        } = evaluate_window_close(&coord, "main", &dirty, false, false)
        else {
            panic!("expected first close prompt");
        };
        assert_eq!(
            plan_window_close_resolution(&coord, "main", &req1, true, true, false),
            WindowCloseResolutionAction::HideWindow
        );

        // After reopening while still dirty, a second close attempt must re-prompt rather than
        // leaking the previous one-shot approval.
        let WindowCloseOutcome::PromptUser {
            request_id: req2, ..
        } = evaluate_window_close(&coord, "main", &dirty, false, false)
        else {
            panic!("expected second close prompt after approved hide");
        };
        assert_ne!(req1, req2);

        // When no handle is registered (`tx.close_window()` path), approval stays intact for one
        // ensuing `on_close` cycle and is consumed when `on_close` runs.
        assert_eq!(
            plan_window_close_resolution(&coord, "main", &req2, true, false, false),
            WindowCloseResolutionAction::CloseCurrentWindow
        );
        assert_eq!(
            evaluate_window_close(&coord, "main", &dirty, false, false),
            WindowCloseOutcome::AllowHideOnly
        );
        assert!(matches!(
            evaluate_window_close(&coord, "main", &dirty, false, false),
            WindowCloseOutcome::PromptUser { .. }
        ));
    }

    #[test]
    fn explicit_quit_prompts_when_dirty_and_quits_only_after_confirmation() {
        let coord = WindowCloseCoordinator::new();
        let clean = AppState::default();
        assert_eq!(
            evaluate_app_quit(&coord, &clean, false),
            WindowCloseOutcome::AllowQuit
        );
        assert!(!coord.is_quitting());

        let mut dirty = AppState::default();
        dirty.composer_edit.text = "unsent prompt".to_string();
        let WindowCloseOutcome::PromptUser {
            request_id: req1,
            dialog,
        } = evaluate_app_quit(&coord, &dirty, false)
        else {
            panic!("expected quit confirmation prompt for unsaved draft");
        };
        assert!(coord.is_quitting());
        assert_eq!(
            parse_window_close_confirm_id(&dialog.id),
            Some(("main", req1.as_str()))
        );

        // Cancelling resets the quitting state so a subsequent quit prompts again.
        assert_eq!(
            plan_window_close_resolution(&coord, "main", &req1, false, true, false),
            WindowCloseResolutionAction::Ignore
        );
        assert!(!coord.is_quitting());

        let WindowCloseOutcome::PromptUser {
            request_id: req2, ..
        } = evaluate_app_quit(&coord, &dirty, false)
        else {
            panic!("expected second quit confirmation prompt after cancel");
        };
        assert_ne!(req1, req2);

        // Confirming a quit prompt always resolves to `Quit`, even on macOS (`quit_on_main_close=false`).
        assert_eq!(
            plan_window_close_resolution(&coord, "main", &req2, true, true, false),
            WindowCloseResolutionAction::Quit
        );
    }
}
