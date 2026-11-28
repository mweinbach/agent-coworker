//! Main-window geometry persistence and multi-display clamping.
//!
//! Replaces `apps/desktop/electron/services/{windowState.ts, deferredMaximize.ts}` with
//! `0o600` atomic JSON storage in `<userData>/window-state.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
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

/// Clamps saved bounds to a visible region of `work_area` at the given scale factor,
/// preserving a reachable titlebar and minimum window size.
pub fn clamp_bounds_in_scale(saved: WindowBounds, work_area: WorkArea, scale: f64) -> WindowBounds {
    let eff_scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let min_width = (f64::from(MAIN_WINDOW_MIN_WIDTH) * eff_scale).round() as i32;
    let min_height = (f64::from(MAIN_WINDOW_MIN_HEIGHT) * eff_scale).round() as i32;
    let width = saved
        .width
        .min(work_area.width.max(min_width))
        .max(min_width);
    let height = saved
        .height
        .min(work_area.height.max(min_height))
        .max(min_height);

    let min_visible_width = ((200.0 * eff_scale).round() as i32).min(width);
    let min_visible_height = ((120.0 * eff_scale).round() as i32).min(height);

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

/// Clamps saved bounds to a visible region of `work_area` at 1x scale.
pub fn clamp_bounds_to_work_area(saved: WindowBounds, work_area: WorkArea) -> WindowBounds {
    clamp_bounds_in_scale(saved, work_area, 1.0)
}

#[derive(Debug, Default)]
struct StoreInner {
    pending: Option<WindowBounds>,
    last_recorded: Option<WindowBounds>,
    loaded_initial: bool,
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
        let parsed = fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<WindowBounds>(&raw).ok())
            .filter(|parsed| parsed.width > 0 && parsed.height > 0);
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.loaded_initial = true;
        if guard.last_recorded.is_none() {
            guard.last_recorded = parsed;
        }
        parsed
    }

    /// Loads saved window bounds clamped to `work_area` (or raw bounds if no display rect given).
    pub fn load_clamped(&self, work_area: Option<WorkArea>) -> Option<WindowBounds> {
        let saved = self.load_raw()?;
        Some(match work_area {
            Some(area) => clamp_bounds_to_work_area(saved, area),
            None => saved,
        })
    }

    /// Returns the most recently recorded bounds if any, or loads once from disk if uninitialized.
    pub fn last_recorded(&self) -> Option<WindowBounds> {
        let (cached, loaded_initial) = {
            let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            (guard.last_recorded, guard.loaded_initial)
        };
        if cached.is_some() || loaded_initial {
            return cached;
        }
        self.load_raw()
    }

    /// Records updated window bounds and schedules a 300 ms debounced disk write.
    pub fn record_bounds(&self, bounds: WindowBounds) {
        if bounds.width <= 0 || bounds.height <= 0 {
            return;
        }
        {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.loaded_initial = true;
            if guard.last_recorded == Some(bounds) {
                return;
            }
            guard.pending = Some(bounds);
            guard.last_recorded = Some(bounds);
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

/// Returns true when CLI flags indicate a headless Rune tooling/screenshot/tree invocation
/// whose fixture viewport must remain deterministic.
pub fn is_headless_cli_args<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let items: Vec<String> = args.into_iter().map(|s| s.as_ref().to_string()).collect();
    let has_native = items.iter().any(|a| a == "--native");
    items.iter().any(|arg| {
        let flag = arg.split('=').next().unwrap_or(arg.as_str());
        matches!(
            flag,
            "--snap"
                | "--snap-on-patch"
                | "--tree"
                | "--html"
                | "--video"
                | "--strip"
                | "--list-scenes"
                | "--first-pixels"
                | "--list-windows"
                | "--desktop"
        ) || (!has_native
            && matches!(
                flag,
                "--script" | "--trace" | "--frames" | "--duration" | "--out"
            ))
    })
}

static HEADLESS_CLI_ARGS: OnceLock<bool> = OnceLock::new();

/// Returns true when running under Rune headless mode or headless CLI flags.
pub fn is_headless_invocation() -> bool {
    rune::is_headless() || *HEADLESS_CLI_ARGS.get_or_init(|| is_headless_cli_args(std::env::args()))
}

/// Builds initial `rune::WindowOptions` and `maximized` flag from `window-state.json`.
///
/// Always returns `(WindowOptions::default(), false)` in headless/fixture runs so `--scene` and
/// `--tree` maintain exact deterministic viewport dimensions.
pub fn startup_window_options(
    store: &WindowStateStore,
    headless: bool,
) -> (rune::WindowOptions, bool) {
    if headless {
        return (rune::WindowOptions::default(), false);
    }
    let Some(saved) = store.load_raw() else {
        return (rune::WindowOptions::default(), false);
    };
    let opts = rune::WindowOptions {
        position: Some((saved.x, saved.y)),
        physical_size: Some((saved.width.max(1) as u32, saved.height.max(1) as u32)),
        ..Default::default()
    };
    (opts, saved.is_maximized)
}

/// Converts a live `rune::WindowPlacement` into `WindowBounds`, preserving normal restore
/// geometry when maximized or fullscreen and skipping invalid/minimized frames.
pub fn bounds_from_placement(
    placement: &rune::WindowPlacement,
    prev: Option<WindowBounds>,
) -> Option<WindowBounds> {
    if placement.minimized {
        return None;
    }
    if placement.maximized || placement.full_screen {
        if let Some(((rx, ry), (rw, rh))) = placement.restore
            && rw > 0
            && rh > 0
        {
            return Some(WindowBounds {
                x: rx,
                y: ry,
                width: rw.min(i32::MAX as u32) as i32,
                height: rh.min(i32::MAX as u32) as i32,
                is_maximized: placement.maximized,
            });
        }
        return prev.map(|p| WindowBounds {
            is_maximized: placement.maximized,
            ..p
        });
    }
    let (w, h) = placement.content_size;
    if w == 0 || h == 0 {
        return None;
    }
    Some(WindowBounds {
        x: placement.position.0,
        y: placement.position.1,
        width: w.min(i32::MAX as u32) as i32,
        height: h.min(i32::MAX as u32) as i32,
        is_maximized: false,
    })
}

/// Clamps an already-opened window handle against its active display work area on the UI thread
/// and records initial bounds into `store`.
pub fn reconcile_opened_window_placement(store: &WindowStateStore, handle: &rune::WindowHandle) {
    let Some(placement) = handle.placement() else {
        return;
    };
    if placement.maximized || placement.minimized || placement.full_screen {
        if let Some(bounds) = bounds_from_placement(&placement, store.last_recorded()) {
            store.record_bounds(bounds);
        }
        return;
    }
    let Some(((dx, dy), (dw, dh))) = placement.display else {
        if let Some(bounds) = bounds_from_placement(&placement, store.last_recorded()) {
            store.record_bounds(bounds);
        }
        return;
    };
    let area = WorkArea {
        x: dx,
        y: dy,
        width: dw.min(i32::MAX as u32) as i32,
        height: dh.min(i32::MAX as u32) as i32,
    };
    let Some(current) = bounds_from_placement(&placement, store.last_recorded()) else {
        return;
    };
    let clamped = clamp_bounds_in_scale(current, area, placement.scale);
    if clamped.x != current.x || clamped.y != current.y {
        handle.set_position((clamped.x, clamped.y));
    }
    if clamped.width != current.width || clamped.height != current.height {
        let scale = if placement.scale.is_finite() && placement.scale > 0.0 {
            placement.scale
        } else {
            1.0
        };
        handle.resize_instant((
            (f64::from(clamped.width) / scale) as f32,
            (f64::from(clamped.height) / scale) as f32,
        ));
    }
    store.record_bounds(clamped);
}

/// Records a placement delivered by Rune's event-driven placement hook.
pub fn record_window_placement_event(store: &WindowStateStore, placement: &rune::WindowPlacement) {
    if is_headless_invocation() {
        return;
    }
    if let Some(bounds) = bounds_from_placement(placement, store.last_recorded()) {
        store.record_bounds(bounds);
    }
}

/// Samples a window's current `WindowPlacement` on the UI thread and schedules persistence.
pub fn record_window_placement(store: &WindowStateStore, handle: &rune::WindowHandle) {
    if is_headless_invocation() {
        return;
    }
    let Some(placement) = handle.placement() else {
        return;
    };
    if let Some(bounds) = bounds_from_placement(&placement, store.last_recorded()) {
        store.record_bounds(bounds);
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

    #[test]
    fn headless_mode_ignores_persisted_bounds_and_placement_preserves_restore_geometry() {
        let tmp = tempdir().unwrap();
        let store = WindowStateStore::new(tmp.path());
        store.record_bounds(WindowBounds {
            x: 150,
            y: 90,
            width: 1400,
            height: 920,
            is_maximized: true,
        });
        store.flush().unwrap();

        let (headless_opts, headless_max) = startup_window_options(&store, true);
        assert!(headless_opts.position.is_none());
        assert!(headless_opts.physical_size.is_none());
        assert!(!headless_max);
        assert!(is_headless_cli_args([
            "cowork-desktop",
            "--tree",
            "out.txt",
            "--scene",
            "default"
        ]));
        assert!(!is_headless_cli_args([
            "cowork-desktop",
            "--scene",
            "default",
            "--native"
        ]));

        let (live_opts, live_max) = startup_window_options(&store, false);
        assert_eq!(live_opts.position, Some((150, 90)));
        assert_eq!(live_opts.physical_size, Some((1400, 920)));
        assert!(live_max);

        let normal_bounds = WindowBounds {
            x: 100,
            y: 120,
            width: 1280,
            height: 820,
            is_maximized: false,
        };
        let max_placement = rune::WindowPlacement {
            position: (0, 0),
            content_position: (0, 0),
            content_size: (2560, 1440),
            scale: 2.0,
            maximized: true,
            minimized: false,
            full_screen: false,
            restore: None,
            display: Some(((0, 0), (2560, 1440))),
        };
        let preserved = bounds_from_placement(&max_placement, Some(normal_bounds)).unwrap();
        assert_eq!(preserved.width, 1280);
        assert_eq!(preserved.height, 820);
        assert!(preserved.is_maximized);

        let win_restore = rune::WindowPlacement {
            restore: Some(((30, 40), (1100, 760))),
            ..max_placement
        };
        let from_restore = bounds_from_placement(&win_restore, Some(normal_bounds)).unwrap();
        assert_eq!(from_restore.x, 30);
        assert_eq!(from_restore.y, 40);
        assert_eq!(from_restore.width, 1100);
        assert_eq!(from_restore.height, 760);
        assert!(from_restore.is_maximized);
    }
}
