//! `cowork/workspace/fileChanged` producer for the server's workspace.
//!
//! Port of `src/server/runtime/WorkspaceFileChangeMonitor.ts` (wired in `ServerRuntime.ts`): one
//! monitor watches the server's working directory for its whole lifetime, ignores the top-level
//! `.cowork`, `.cowork-trash`, `.git` and `node_modules` trees, debounces raw events per path
//! (25 ms by default), and then publishes the path plus its parent directory. A path that still
//! stats as a file or directory is published as `changed` with its canonical path and
//! [`FileChangeVersion`]; anything else is published as `deleted` with the raw path and a `null`
//! version. The runtime broadcasts each event to every connection with the workspace `cwd`.
//!
//! The `/cowork/fs/rename` and `/cowork/fs/trash` routes emit the same events directly through
//! [`broadcast_workspace_file_changed`] (`webDesktopRoutes.ts` parity), so previews refresh even
//! before the watcher reports the move.
//!
//! Platform notes:
//! - Raw events reach a dedicated worker thread over a channel; the `notify` callback only filters
//!   and forwards, so the watcher's event loop is never blocked by stat calls or broadcasts.
//! - Pure `Access` events (open, read, non-writing close) are dropped in the callback. inotify
//!   reports one for every file open in the tree, and reacting to them is what livelocked the
//!   skill watcher (see `cowork-harness` `extensions/watcher.rs`). A writing close is kept.
//! - On Linux, `notify`'s recursive mode puts an inotify watch on every directory, including
//!   `node_modules` and `.git`, and fails the whole call when one of them cannot be watched. The
//!   monitor instead adds one non-recursive watch per directory, skipping the ignored top-level
//!   trees, and watches directories as they are created or moved in. macOS (FSEvents) and Windows
//!   (`ReadDirectoryChangesW`) watch the whole tree with one handle, so they use recursive mode and
//!   only filter.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use cowork_harness::ooxml::{FileChangeVersion, file_change_version_from_metadata};
use cowork_protocol::{JsonRpcLiteNotification, JsonRpcLiteOutbound};
use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::{Condvar, Mutex};
use serde_json::json;

use crate::registry::ServerRuntimeState;

/// JSON-RPC notification method carrying [`WorkspaceFileChangeEvent`]s.
pub const WORKSPACE_FILE_CHANGED_METHOD: &str = "cowork/workspace/fileChanged";

/// Per-path quiet period before a change is published (`debounceMs ?? 25` in the TS monitor).
pub const DEFAULT_WORKSPACE_FILE_CHANGE_DEBOUNCE: Duration = Duration::from_millis(25);

/// Top-level workspace entries whose subtrees never produce events.
pub const IGNORED_WORKSPACE_DIRECTORIES: [&str; 4] =
    [".cowork", ".cowork-trash", ".git", "node_modules"];

#[cfg(any(target_os = "linux", target_os = "android"))]
const ROOT_RECURSIVE_MODE: RecursiveMode = RecursiveMode::NonRecursive;
#[cfg(not(any(target_os = "linux", target_os = "android")))]
const ROOT_RECURSIVE_MODE: RecursiveMode = RecursiveMode::Recursive;

/// `kind` discriminant of a `cowork/workspace/fileChanged` payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceFileChangeKind {
    Changed,
    Deleted,
}

impl WorkspaceFileChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Changed => "changed",
            Self::Deleted => "deleted",
        }
    }
}

/// One workspace file change (`WorkspaceFileChangeEvent` in `src/shared/fileVersion.ts`).
///
/// `version` is `Some` exactly when `kind` is [`WorkspaceFileChangeKind::Changed`].
#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceFileChangeEvent {
    pub kind: WorkspaceFileChangeKind,
    pub path: PathBuf,
    pub version: Option<FileChangeVersion>,
}

impl WorkspaceFileChangeEvent {
    pub fn changed(path: PathBuf, version: FileChangeVersion) -> Self {
        Self {
            kind: WorkspaceFileChangeKind::Changed,
            path,
            version: Some(version),
        }
    }

    pub fn deleted(path: PathBuf) -> Self {
        Self {
            kind: WorkspaceFileChangeKind::Deleted,
            path,
            version: None,
        }
    }

    /// The `cowork/workspace/fileChanged` notification: `{ cwd, kind, path, version }`.
    pub fn to_notification(&self, cwd: &Path) -> JsonRpcLiteNotification {
        JsonRpcLiteNotification {
            method: WORKSPACE_FILE_CHANGED_METHOD.to_owned(),
            params: Some(json!({
                "cwd": cwd.to_string_lossy(),
                "kind": self.kind.as_str(),
                "path": self.path.to_string_lossy(),
                "version": self.version,
            })),
        }
    }
}

/// Broadcasts `event` to every connection, tagged with `reported_cwd`: the workspace directory as
/// the server was given it (TS `config.workingDirectory`), not its canonical form.
pub fn broadcast_workspace_file_changed(
    runtime: &ServerRuntimeState,
    reported_cwd: &Path,
    event: &WorkspaceFileChangeEvent,
) {
    runtime.broadcast_to_all(&JsonRpcLiteOutbound::Notification(
        event.to_notification(reported_cwd),
    ));
}

/// Starts the runtime's workspace monitor on `runtime.working_directory`; events carry
/// `reported_cwd` as their `cwd`. Failure is logged and leaves the server without a monitor, as
/// `ServerRuntime.ts` does.
pub fn start_for_runtime(
    runtime: &Arc<ServerRuntimeState>,
    reported_cwd: &Path,
) -> Option<WorkspaceFileChangeMonitor> {
    let cwd = runtime.working_directory.clone();
    let reported_cwd = reported_cwd.to_path_buf();
    let weak: Weak<ServerRuntimeState> = Arc::downgrade(runtime);
    let started = WorkspaceFileChangeMonitor::start(
        &cwd,
        DEFAULT_WORKSPACE_FILE_CHANGE_DEBOUNCE,
        move |event| {
            if let Some(runtime) = weak.upgrade() {
                broadcast_workspace_file_changed(&runtime, &reported_cwd, &event);
            }
        },
    );
    match started {
        Ok(monitor) => Some(monitor),
        Err(err) => {
            tracing::warn!(
                "[workspace-files] unable to monitor {}: {err}",
                cwd.display()
            );
            None
        }
    }
}

/// Whether `candidate` is inside `cwd` and outside the ignored top-level directories.
pub fn should_monitor_workspace_path(cwd: &Path, candidate: &Path) -> bool {
    let Ok(relative) = candidate.strip_prefix(cwd) else {
        return false;
    };
    match relative.components().next() {
        None => true,
        Some(Component::Normal(first)) => !IGNORED_WORKSPACE_DIRECTORIES
            .iter()
            .any(|name| first == OsStr::new(name)),
        Some(_) => false,
    }
}

enum MonitorMessage {
    Event(notify::Result<Event>),
    Stop,
}

struct MonitorShared {
    stopped: AtomicBool,
    watcher: Mutex<Option<RecommendedWatcher>>,
    ready: Mutex<bool>,
    ready_changed: Condvar,
}

impl MonitorShared {
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Marks the monitor stopped and releases the OS watcher; returns whether this call stopped it.
    fn stop_watching(&self) -> bool {
        let first = !self.stopped.swap(true, Ordering::SeqCst);
        drop(self.watcher.lock().take());
        self.mark_ready();
        first
    }

    fn mark_ready(&self) {
        *self.ready.lock() = true;
        self.ready_changed.notify_all();
    }
}

/// Watches one workspace directory and reports debounced [`WorkspaceFileChangeEvent`]s.
///
/// Stopping (explicitly or on drop) releases the OS watcher and joins the worker thread, so no
/// event is delivered after [`WorkspaceFileChangeMonitor::stop`] returns.
pub struct WorkspaceFileChangeMonitor {
    cwd: PathBuf,
    shared: Arc<MonitorShared>,
    control: mpsc::Sender<MonitorMessage>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl WorkspaceFileChangeMonitor {
    /// Starts watching `cwd` (canonicalized). `on_change` runs on the monitor's worker thread.
    pub fn start<F>(cwd: &Path, debounce: Duration, on_change: F) -> notify::Result<Self>
    where
        F: Fn(WorkspaceFileChangeEvent) + Send + 'static,
    {
        let cwd = canonicalize_sync(cwd);
        let (tx, rx) = mpsc::channel::<MonitorMessage>();
        let event_tx = tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = &res
                && is_pure_access(&event.kind)
            {
                return;
            }
            let _ = event_tx.send(MonitorMessage::Event(res));
        })?;
        watcher.watch(&cwd, ROOT_RECURSIVE_MODE)?;

        let shared = Arc::new(MonitorShared {
            stopped: AtomicBool::new(false),
            watcher: Mutex::new(Some(watcher)),
            ready: Mutex::new(false),
            ready_changed: Condvar::new(),
        });
        let worker = MonitorWorker {
            cwd: cwd.clone(),
            debounce,
            on_change,
            shared: Arc::clone(&shared),
            pending: HashMap::new(),
            #[cfg(any(target_os = "linux", target_os = "android"))]
            watch_limit_reached: false,
        };
        let handle = std::thread::Builder::new()
            .name("cowork-workspace-files".to_owned())
            .spawn(move || worker.run(rx))
            .map_err(notify::Error::io)?;

        Ok(Self {
            cwd,
            shared,
            control: tx,
            worker: Mutex::new(Some(handle)),
        })
    }

    /// The canonical workspace directory being watched.
    pub fn cwd(&self) -> &Path {
        &self.cwd
    }

    /// Waits until the initial watch set is armed (on Linux, after every existing directory has
    /// its own watch). Returns `false` on timeout.
    pub fn wait_until_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut ready = self.shared.ready.lock();
        while !*ready {
            if self
                .shared
                .ready_changed
                .wait_until(&mut ready, deadline)
                .timed_out()
            {
                return *ready;
            }
        }
        true
    }

    pub fn is_stopped(&self) -> bool {
        self.shared.is_stopped()
    }

    /// Stops watching and discards pending (not yet published) changes. Idempotent.
    pub fn stop(&self) {
        self.shared.stop_watching();
        let _ = self.control.send(MonitorMessage::Stop);
        let handle = self.worker.lock().take();
        if let Some(handle) = handle
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }
}

impl Drop for WorkspaceFileChangeMonitor {
    fn drop(&mut self) {
        self.stop();
    }
}

/// `Access` events other than a writing close never mutate anything.
fn is_pure_access(kind: &EventKind) -> bool {
    matches!(kind, EventKind::Access(access) if *access != AccessKind::Close(AccessMode::Write))
}

struct MonitorWorker<F> {
    cwd: PathBuf,
    debounce: Duration,
    on_change: F,
    shared: Arc<MonitorShared>,
    /// Path -> publish deadline. A new raw event for a pending path pushes its deadline back.
    pending: HashMap<PathBuf, Instant>,
    #[cfg(any(target_os = "linux", target_os = "android"))]
    watch_limit_reached: bool,
}

impl<F> MonitorWorker<F>
where
    F: Fn(WorkspaceFileChangeEvent),
{
    fn run(mut self, rx: mpsc::Receiver<MonitorMessage>) {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            let cwd = self.cwd.clone();
            self.watch_directory_tree(&cwd);
        }
        self.shared.mark_ready();

        loop {
            let received = match self.pending.values().min().copied() {
                Some(deadline) => {
                    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                }
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match received {
                Ok(MonitorMessage::Event(Ok(event))) => self.handle_event(event),
                Ok(MonitorMessage::Event(Err(err))) => {
                    // `watcher.on("error", () => this.stop())`.
                    if self.shared.stop_watching() {
                        tracing::warn!(
                            "[workspace-files] stopped monitoring {}: {err}",
                            self.cwd.display()
                        );
                    }
                }
                Ok(MonitorMessage::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            if self.shared.is_stopped() {
                break;
            }
            self.publish_due();
        }
        self.pending.clear();
    }

    fn should_monitor(&self, candidate: &Path) -> bool {
        should_monitor_workspace_path(&self.cwd, candidate)
    }

    fn handle_event(&mut self, event: Event) {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let may_add_directory = matches!(
            event.kind,
            EventKind::Any
                | EventKind::Create(_)
                | EventKind::Modify(notify::event::ModifyKind::Name(_))
        );
        for path in event.paths {
            if !self.should_monitor(&path) {
                continue;
            }
            #[cfg(any(target_os = "linux", target_os = "android"))]
            if may_add_directory
                && path != self.cwd
                && std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir())
            {
                self.watch_directory_tree(&path);
            }
            self.pending.insert(path, Instant::now() + self.debounce);
        }
    }

    fn publish_due(&mut self) {
        let now = Instant::now();
        let mut due: Vec<PathBuf> = self
            .pending
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(path, _)| path.clone())
            .collect();
        if due.is_empty() {
            return;
        }
        due.sort();
        for path in due {
            self.pending.remove(&path);
            self.publish_path_and_parent(&path);
        }
    }

    fn publish_path_and_parent(&self, changed_path: &Path) {
        self.publish_path(changed_path);
        if let Some(parent) = changed_path.parent()
            && parent != changed_path
            && self.should_monitor(parent)
        {
            self.publish_path(parent);
        }
    }

    fn publish_path(&self, changed_path: &Path) {
        if self.shared.is_stopped() {
            return;
        }
        let resolved = canonicalize_sync(changed_path);
        if !self.should_monitor(&resolved) {
            return;
        }
        let event = match std::fs::metadata(&resolved) {
            Ok(meta) if meta.is_file() || meta.is_dir() => WorkspaceFileChangeEvent::changed(
                resolved,
                file_change_version_from_metadata(&meta),
            ),
            _ => WorkspaceFileChangeEvent::deleted(changed_path.to_path_buf()),
        };
        self.emit(event);
    }

    fn emit(&self, event: WorkspaceFileChangeEvent) {
        if self.shared.is_stopped() {
            return;
        }
        // Filesystem monitoring is best-effort and must not take the worker down.
        let _ = catch_unwind(AssertUnwindSafe(|| (self.on_change)(event)));
    }

    /// Adds a non-recursive watch to `root` (unless it is the already-watched workspace root) and
    /// every directory below it, skipping ignored trees and symlinks.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    fn watch_directory_tree(&mut self, root: &Path) {
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if self.shared.is_stopped() || self.watch_limit_reached {
                return;
            }
            if !self.should_monitor(&dir) {
                continue;
            }
            if dir != self.cwd {
                let result = match self.shared.watcher.lock().as_mut() {
                    Some(watcher) => watcher.watch(&dir, RecursiveMode::NonRecursive),
                    None => return,
                };
                match result {
                    Ok(()) => {}
                    Err(err) if matches!(err.kind, notify::ErrorKind::MaxFilesWatch) => {
                        self.watch_limit_reached = true;
                        tracing::warn!(
                            "[workspace-files] inotify watch limit reached under {}; \
                             deeper changes will not be reported",
                            self.cwd.display()
                        );
                        return;
                    }
                    // The directory vanished or is unreadable; its siblings are still watched.
                    Err(_) => continue,
                }
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    stack.push(entry.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_only_top_level_ignored_directories() {
        let cwd = Path::new("/ws");
        assert!(should_monitor_workspace_path(cwd, Path::new("/ws")));
        assert!(should_monitor_workspace_path(cwd, Path::new("/ws/a.md")));
        assert!(should_monitor_workspace_path(
            cwd,
            Path::new("/ws/src/node_modules/x")
        ));
        assert!(should_monitor_workspace_path(
            cwd,
            Path::new("/ws/.gitignore")
        ));
        for ignored in IGNORED_WORKSPACE_DIRECTORIES {
            assert!(!should_monitor_workspace_path(cwd, &cwd.join(ignored)));
            assert!(!should_monitor_workspace_path(
                cwd,
                &cwd.join(ignored).join("f")
            ));
        }
        assert!(!should_monitor_workspace_path(
            cwd,
            Path::new("/other/a.md")
        ));
        assert!(!should_monitor_workspace_path(cwd, Path::new("/wsx/a.md")));
        assert!(!should_monitor_workspace_path(
            cwd,
            Path::new("/ws/../a.md")
        ));
    }

    #[test]
    fn notification_payload_matches_ts_shape() {
        let version = FileChangeVersion {
            modified_at_ms: 1.5,
            change_time_ms: 2.0,
            size: 3,
            fingerprint: "1:2:1.5:2:3".to_owned(),
        };
        let changed = WorkspaceFileChangeEvent::changed(PathBuf::from("/ws/a.md"), version)
            .to_notification(Path::new("/ws"));
        assert_eq!(changed.method, WORKSPACE_FILE_CHANGED_METHOD);
        assert_eq!(
            changed.params.unwrap(),
            json!({
                "cwd": "/ws",
                "kind": "changed",
                "path": "/ws/a.md",
                "version": {
                    "modifiedAtMs": 1.5,
                    "changeTimeMs": 2.0,
                    "size": 3,
                    "fingerprint": "1:2:1.5:2:3",
                },
            })
        );
        let deleted = WorkspaceFileChangeEvent::deleted(PathBuf::from("/ws/a.md"))
            .to_notification(Path::new("/ws"));
        assert_eq!(
            deleted.params.unwrap(),
            json!({ "cwd": "/ws", "kind": "deleted", "path": "/ws/a.md", "version": null })
        );
    }

    #[test]
    fn drops_pure_access_events_but_keeps_writing_close() {
        assert!(is_pure_access(&EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(is_pure_access(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_pure_access(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(!is_pure_access(&EventKind::Modify(
            notify::event::ModifyKind::Any
        )));
    }
}
