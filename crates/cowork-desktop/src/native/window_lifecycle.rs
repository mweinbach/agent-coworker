//! Window activation, reveal, close-confirmation coordination, and maximize recovery
//! matching `apps/desktop/electron/services/windowActivation.ts` and `windowCloseCoordinator.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::state::AppState;

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
}
