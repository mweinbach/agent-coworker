//! Main-window geometry persistence and multi-display clamping.
//!
//! Replaces `apps/desktop/electron/services/{windowState.ts, deferredMaximize.ts}` with
//! `0o600` atomic JSON storage in `<userData>/window-state.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

pub const WINDOW_STATE_FILENAME: &str = "window-state.json";
pub const MAIN_WINDOW_MIN_WIDTH: i32 = 840;
pub const MAIN_WINDOW_MIN_HEIGHT: i32 = 560;
const DEBOUNCE_DURATION: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub is_maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Clamps saved bounds to a visible region of `work_area`, keeping the titlebar reachable.
pub fn clamp_bounds_to_work_area(saved: WindowBounds, work_area: WorkArea) -> WindowBounds {
    let width = saved
        .width
        .min(work_area.width.max(MAIN_WINDOW_MIN_WIDTH))
        .max(MAIN_WINDOW_MIN_WIDTH);
    let height = saved
        .height
        .min(work_area.height.max(MAIN_WINDOW_MIN_HEIGHT))
        .max(MAIN_WINDOW_MIN_HEIGHT);

    let min_visible_width = 200.min(width);
    let min_visible_height = 120.min(height);

    let min_x = work_area.x - width + min_visible_width;
    let max_x = work_area.x + work_area.width - min_visible_width;
    let x = if max_x >= min_x {
        saved.x.clamp(min_x, max_x)
    } else {
        work_area.x
    };

    let min_y = work_area.y;
    let max_y = (work_area.y + work_area.height - min_visible_height).max(min_y);
    let y = saved.y.clamp(min_y, max_y);

    WindowBounds {
        x,
        y,
        width,
        height,
        is_maximized: saved.is_maximized,
    }
}

#[derive(Debug, Default)]
struct StoreInner {
    pending: Option<WindowBounds>,
    last_written_json: Option<String>,
    deadline: Option<Instant>,
}

/// Persists `window-state.json` with 300 ms debouncing and explicit synchronous `flush()`.
#[derive(Clone)]
pub struct WindowStateStore {
    path: PathBuf,
    inner: Arc<Mutex<StoreInner>>,
    notify: Arc<Notify>,
}

impl WindowStateStore {
    pub fn new(user_data_dir: &Path) -> Self {
        Self {
            path: user_data_dir.join(WINDOW_STATE_FILENAME),
            inner: Arc::new(Mutex::new(StoreInner::default())),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reads saved window bounds from disk, returning `None` if missing or invalid.
    pub fn load_raw(&self) -> Option<WindowBounds> {
        let raw = fs::read_to_string(&self.path).ok()?;
        let parsed: WindowBounds = serde_json::from_str(&raw).ok()?;
        if parsed.width > 0 && parsed.height > 0 {
            Some(parsed)
        } else {
            None
        }
    }

    /// Loads saved window bounds clamped to `work_area` (or raw bounds if no display rect given).
    pub fn load_clamped(&self, work_area: Option<WorkArea>) -> Option<WindowBounds> {
        let saved = self.load_raw()?;
        Some(match work_area {
            Some(area) => clamp_bounds_to_work_area(saved, area),
            None => saved,
        })
    }

    /// Records updated window bounds and schedules a 300 ms debounced disk write.
    pub fn record_bounds(&self, bounds: WindowBounds) {
        if bounds.width <= 0 || bounds.height <= 0 {
            return;
        }
        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.pending = Some(bounds);
            guard.deadline = Some(Instant::now() + DEBOUNCE_DURATION);
        }
        self.notify.notify_one();
    }

    /// Spawns the background debounced flush loop onto the active Tokio runtime.
    pub fn spawn_debounce_loop(&self, mut shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        let store = self.clone();
        tokio::spawn(async move {
            loop {
                let maybe_wait = {
                    let guard = store.inner.lock().unwrap_or_else(|e| e.into_inner());
                    guard
                        .deadline
                        .map(|d| d.saturating_duration_since(Instant::now()))
                };

                tokio::select! {
                    _ = store.notify.notified() => {}
                    _ = async {
                        if let Some(delay) = maybe_wait {
                            tokio::time::sleep(delay).await;
                        } else {
                            std::future::pending::<()>().await;
                        }
                    } => {
                        let _ = store.flush();
                    }
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() {
                            let _ = store.flush();
                            break;
                        }
                    }
                }
            }
        });
    }

    /// Synchronously writes any buffered bounds to `window-state.json` atomically (`0o600`).
    pub fn flush(&self) -> Result<(), std::io::Error> {
        let (pending, last_written) = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.deadline = None;
            (guard.pending, guard.last_written_json.clone())
        };

        let Some(bounds) = pending else {
            return Ok(());
        };
        let Ok(payload) = serde_json::to_string(&bounds) else {
            return Ok(());
        };
        if last_written.as_deref() == Some(payload.as_str()) {
            return Ok(());
        }

        if let Some(parent) = self.path.parent() {
            cowork_config::ensure_private_dir_sync(parent).map_err(std::io::Error::other)?;
        }
        cowork_config::write_text_file_atomic(&self.path, &payload, Some(0o600))
            .map_err(std::io::Error::other)?;
        cowork_config::harden_private_file_sync(&self.path);

        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.last_written_json = Some(payload);
        Ok(())
    }
}

/// Defers initial window maximization until first show/readiness, matching Electron behavior.
#[derive(Debug, Default)]
pub struct DeferredMaximize {
    should_maximize: bool,
    applied: bool,
}

impl DeferredMaximize {
    pub fn new(should_maximize: bool) -> Self {
        Self {
            should_maximize,
            applied: false,
        }
    }

    /// Returns `true` exactly once when initial maximize should run.
    pub fn take_ready_to_maximize(&mut self) -> bool {
        if self.should_maximize && !self.applied {
            self.applied = true;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn clamps_offscreen_window_back_into_work_area() {
        let saved = WindowBounds {
            x: -5000,
            y: -200,
            width: 3000,
            height: 2000,
            is_maximized: false,
        };
        let work_area = WorkArea {
            x: 0,
            y: 25,
            width: 1440,
            height: 875,
        };
        let clamped = clamp_bounds_to_work_area(saved, work_area);
        assert_eq!(clamped.width, 1440);
        assert_eq!(clamped.height, 875);
        assert_eq!(clamped.y, 25); // titlebar never rises above workArea.y
        assert!(clamped.x >= work_area.x - clamped.width + 200);
    }

    #[test]
    fn persists_and_flushes_bounds_to_disk() {
        let tmp = tempdir().unwrap();
        let store = WindowStateStore::new(tmp.path());
        assert!(store.load_raw().is_none());

        let bounds = WindowBounds {
            x: 120,
            y: 80,
            width: 1200,
            height: 820,
            is_maximized: true,
        };
        store.record_bounds(bounds);
        store.flush().unwrap();

        assert_eq!(store.load_raw(), Some(bounds));
    }

    #[test]
    fn deferred_maximize_fires_at_most_once() {
        let mut dm = DeferredMaximize::new(true);
        assert!(dm.take_ready_to_maximize());
        assert!(!dm.take_ready_to_maximize());
    }
}
