//! Application quit and resource shutdown coordinator.
//!
//! Replaces `apps/desktop/electron/services/shutdown.ts`: stops all child workspace
//! servers cleanly, drains debounced `WindowStateStore` writes, and flushes local logs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::local_logs::LocalLogger;
use super::server_manager::ServerManager;
use super::window_state::WindowStateStore;

/// Coordinates orderly native-service teardown on exit.
#[derive(Clone)]
pub struct ShutdownCoordinator {
    server_manager: ServerManager,
    window_state: Option<WindowStateStore>,
    logger: Option<Arc<LocalLogger>>,
    shutdown_tx: Option<tokio::sync::watch::Sender<bool>>,
    started: Arc<AtomicBool>,
    done: Arc<(Mutex<bool>, Condvar)>,
}

impl ShutdownCoordinator {
    pub fn new(
        server_manager: ServerManager,
        window_state: Option<WindowStateStore>,
        logger: Option<Arc<LocalLogger>>,
        shutdown_tx: Option<tokio::sync::watch::Sender<bool>>,
    ) -> Self {
        Self {
            server_manager,
            window_state,
            logger,
            shutdown_tx,
            started: Arc::new(AtomicBool::new(false)),
            done: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    pub fn completion_latch(&self) -> Arc<(Mutex<bool>, Condvar)> {
        self.done.clone()
    }

    /// Blocks synchronously (up to `timeout`) until [`Self::shutdown`] completes.
    /// Intended for Rune's `on_quit` hook, since Rune uses `fast_exit` after `on_quit` returns.
    pub fn wait_until_done(latch: &(Mutex<bool>, Condvar), timeout: Duration) -> bool {
        let (lock, cvar) = latch;
        let deadline = Instant::now() + timeout;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        while !*guard {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (next, wait_res) = cvar
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|e| e.into_inner());
            guard = next;
            if wait_res.timed_out() && !*guard {
                return false;
            }
        }
        true
    }

    pub fn mark_done(&self) {
        let (lock, cvar) = &*self.done;
        let mut guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        *guard = true;
        cvar.notify_all();
    }

    /// Runs cleanup idempotently across `server_manager`, `window_state`, and `logger`.
    pub async fn shutdown(&self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        if let Some(tx) = &self.shutdown_tx {
            let _ = tx.send(true);
        }
        self.server_manager.stop_all().await;
        if let Some(ws) = &self.window_state {
            let _ = ws.flush();
        }
        if let Some(logger) = &self.logger {
            logger.flush_all();
        }
        self.mark_done();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::server_manager::ServerManagerRuntime;
    use tempfile::tempdir;

    #[tokio::test]
    async fn shutdown_is_idempotent_and_flushes_window_state() {
        let tmp = tempdir().unwrap();
        let mgr = ServerManager::new(
            ServerManagerRuntime {
                user_data_dir: tmp.path().to_path_buf(),
                resources_dir: None,
                current_exe_dir: None,
                repo_root: None,
                is_packaged: false,
            },
            None,
            None,
        );
        let ws = WindowStateStore::new(tmp.path());
        ws.record_bounds(crate::native::window_state::WindowBounds {
            x: 10,
            y: 20,
            width: 900,
            height: 600,
            is_maximized: false,
        });

        let (tx, _rx) = tokio::sync::watch::channel(false);
        let coordinator = ShutdownCoordinator::new(mgr, Some(ws.clone()), None, Some(tx));
        coordinator.shutdown().await;
        coordinator.shutdown().await;

        assert!(ws.load_raw().is_some());
    }
}
