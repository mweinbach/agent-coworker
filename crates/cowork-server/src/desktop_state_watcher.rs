//! Desktop `state.json` change notifications (TS `watchStateChanges`).
//!
//! The Electron shell writes `<userData>/state.json` itself, so the server has
//! to notice external writes and broadcast `workspace/listChanged`. This mirrors
//! origin/main `src/server/webDesktopService.ts`:
//!
//! - the user-data directory is watched (non-recursively); events naming another
//!   file are ignored, events without a file name are treated as relevant;
//! - events are debounced with a 25 ms trailing timer;
//! - when the timer fires, the `dev:ino:size:mtime` signature of `state.json` is
//!   compared to the last one seen, and listeners run only if it changed;
//! - `saveState` records the signature of its own write (so the watcher does not
//!   echo it) and then notifies listeners directly.
//!
//! If the platform watcher cannot start, the file signature is polled instead.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use parking_lot::Mutex;

use crate::http_desktop::WebDesktopService;
use crate::registry::ServerRuntimeState;
use crate::startup::ShutdownCoordinator;

/// Trailing debounce applied to directory events (TS: `setTimeout(..., 25)`).
pub const STATE_WATCH_DEBOUNCE: Duration = Duration::from_millis(25);
/// Poll interval used only when no platform file watcher is available.
const STATE_POLL_INTERVAL: Duration = Duration::from_millis(500);
const STATE_FILE_NAME: &str = "state.json";

type Listener = Arc<dyn Fn() + Send + Sync>;

/// Listener registry plus the last observed `state.json` signature.
#[derive(Default)]
pub struct StateChangeHub {
    listeners: Mutex<Vec<(u64, Listener)>>,
    next_id: AtomicU64,
    last_signature: Mutex<Option<String>>,
}

impl fmt::Debug for StateChangeHub {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StateChangeHub")
            .field("listeners", &self.listeners.lock().len())
            .field("last_signature", &*self.last_signature.lock())
            .finish()
    }
}

impl StateChangeHub {
    pub fn add_listener(&self, listener: Listener) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.listeners.lock().push((id, listener));
        id
    }

    pub fn remove_listener(&self, id: u64) {
        self.listeners.lock().retain(|(lid, _)| *lid != id);
    }

    /// Runs every listener (outside the registry lock).
    pub fn notify(&self) {
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .iter()
            .map(|(_, l)| Arc::clone(l))
            .collect();
        for listener in listeners {
            listener();
        }
    }

    /// Records the signature of `state_file` as already seen.
    pub fn record_signature(&self, state_file: &Path) {
        *self.last_signature.lock() = read_state_file_signature(state_file);
    }

    /// Returns true (and records the new signature) when `state_file` changed
    /// since the last recorded signature.
    pub fn take_change(&self, state_file: &Path) -> bool {
        let signature = read_state_file_signature(state_file);
        let mut last = self.last_signature.lock();
        if *last == signature {
            return false;
        }
        *last = signature;
        true
    }
}

/// `dev:ino:size:mtime` of `state.json`, or `None` when it does not exist.
pub fn read_state_file_signature(state_file: &Path) -> Option<String> {
    let meta = std::fs::metadata(state_file).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(format!(
            "{}:{}:{}:{}",
            meta.dev(),
            meta.ino(),
            meta.len(),
            mtime
        ))
    }
    #[cfg(not(unix))]
    {
        Some(format!("0:0:{}:{}", meta.len(), mtime))
    }
}

fn is_relevant_event(event: &Event) -> bool {
    // Reads/opens never change the file and would otherwise fire on every
    // `loadState`.
    if let EventKind::Access(kind) = event.kind
        && kind != AccessKind::Close(AccessMode::Write)
    {
        return false;
    }
    event.paths.is_empty()
        || event
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == STATE_FILE_NAME))
}

/// Subscription returned by [`watch_state_changes`]; dropping it removes the
/// listener and stops the watcher task.
pub struct StateWatchHandle {
    service: Weak<WebDesktopService>,
    listener_id: u64,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for StateWatchHandle {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(svc) = self.service.upgrade() {
            svc.state_changes().remove_listener(self.listener_id);
        }
    }
}

/// TS `watchStateChanges(listener)`: registers `listener` for both in-process
/// saves and external writes of `state.json`. Must run inside a Tokio runtime.
pub fn watch_state_changes(
    service: &Arc<WebDesktopService>,
    listener: impl Fn() + Send + Sync + 'static,
) -> StateWatchHandle {
    let hub_owner = Arc::downgrade(service);
    let listener_id = service.state_changes().add_listener(Arc::new(listener));
    let user_data_dir = service.user_data_dir().to_path_buf();
    let state_file = service.state_file_path();
    let _ = cowork_config::ensure_private_dir_sync(&user_data_dir);
    service.state_changes().record_signature(&state_file);

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res
            && is_relevant_event(&event)
        {
            let _ = tx.send(());
        }
    })
    .and_then(|mut w| {
        w.watch(&user_data_dir, RecursiveMode::NonRecursive)?;
        Ok(w)
    });

    let weak = hub_owner.clone();
    let task = match watcher {
        Ok(watcher) => tokio::spawn(run_event_loop(watcher, rx, weak, state_file)),
        Err(err) => {
            tracing::warn!(
                error = %err,
                dir = %user_data_dir.display(),
                "desktop state watcher unavailable; polling state.json instead"
            );
            tokio::spawn(run_poll_loop(weak, state_file))
        }
    };

    StateWatchHandle {
        service: hub_owner,
        listener_id,
        task,
    }
}

async fn run_event_loop(
    watcher: notify::RecommendedWatcher,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    service: Weak<WebDesktopService>,
    state_file: PathBuf,
) {
    // Keep the platform watcher alive for as long as this task runs.
    let _watcher = watcher;
    while rx.recv().await.is_some() {
        // Trailing debounce: every new event restarts the timer.
        loop {
            match tokio::time::timeout(STATE_WATCH_DEBOUNCE, rx.recv()).await {
                Ok(Some(())) => continue,
                Ok(None) => return,
                Err(_) => break,
            }
        }
        let Some(svc) = service.upgrade() else {
            return;
        };
        if svc.state_changes().take_change(&state_file) {
            svc.state_changes().notify();
        }
    }
}

async fn run_poll_loop(service: Weak<WebDesktopService>, state_file: PathBuf) {
    let mut interval = tokio::time::interval(STATE_POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let Some(svc) = service.upgrade() else {
            return;
        };
        if svc.state_changes().take_change(&state_file) {
            svc.state_changes().notify();
        }
    }
}

/// Runtime hook (TS `ServerRuntime`: `desktopService.watchStateChanges(() =>
/// broadcastWorkspaceListChanged())`). No-op unless the web desktop service is
/// active; the watcher stops when `shutdown` triggers.
pub fn start_for_runtime(runtime: &Arc<ServerRuntimeState>, shutdown: &ShutdownCoordinator) {
    let Some(service) = runtime.desktop_service.clone() else {
        return;
    };
    let weak_runtime = Arc::downgrade(runtime);
    let handle = watch_state_changes(&service, move || {
        if let Some(rt) = weak_runtime.upgrade() {
            rt.broadcast_workspace_list_changed();
        }
    });
    let shutdown = shutdown.clone();
    tokio::spawn(async move {
        shutdown.cancelled().await;
        drop(handle);
    });
}
