//! Recursive workspace directory watcher with debounced path aggregation and bounded
//! backoff restarts, mirroring `apps/desktop/electron/services/workspaceDirectoryWatcher.ts`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cowork_config::canonicalize_sync;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

const DEFAULT_WATCH_DEBOUNCE: Duration = Duration::from_millis(40);
const WATCH_RESTART_DELAYS: [Duration; 3] = [
    Duration::from_secs(2),
    Duration::from_secs(10),
    Duration::from_secs(30),
];
const WATCH_HEALTHY_RESET: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WatchScope {
    pub workspace_id: String,
    pub root_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WatchChangeKind {
    Changed,
    Removed,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceWatchBatch {
    pub workspace_id: String,
    pub root_path: PathBuf,
    pub paths: Vec<PathBuf>,
    pub affected_dirs: Vec<PathBuf>,
    pub kind: WatchChangeKind,
}

pub type WatchCallback = Arc<dyn Fn(WorkspaceWatchBatch) + Send + Sync>;

struct ActiveScope {
    task: JoinHandle<()>,
    stop_tx: mpsc::Sender<()>,
}

/// Manages debounced recursive filesystem watchers keyed by `(workspace_id, root_path)`.
#[derive(Clone, Default)]
pub struct WorkspaceDirectoryWatcher {
    scopes: Arc<Mutex<HashMap<WatchScope, ActiveScope>>>,
}

impl WorkspaceDirectoryWatcher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts watching `root_path` for `workspace_id`, replacing any prior watch for the same scope.
    pub async fn watch(
        &self,
        workspace_id: impl Into<String>,
        root_path: impl AsRef<Path>,
        callback: WatchCallback,
    ) -> Result<()> {
        let scope = WatchScope {
            workspace_id: workspace_id.into(),
            root_path: canonicalize_sync(root_path.as_ref()),
        };

        let (stop_tx, stop_rx) = mpsc::channel::<()>(1);
        let task = spawn_scope_watcher(scope.clone(), callback, stop_rx)?;

        let mut map = self.scopes.lock().await;
        if let Some(prev) = map.insert(scope, ActiveScope { task, stop_tx }) {
            let _ = prev.stop_tx.try_send(());
            prev.task.abort();
        }
        Ok(())
    }

    /// Stops watching a previously registered `(workspace_id, root_path)` scope.
    pub async fn unwatch(&self, workspace_id: &str, root_path: &Path) {
        let scope = WatchScope {
            workspace_id: workspace_id.to_string(),
            root_path: canonicalize_sync(root_path),
        };
        let mut map = self.scopes.lock().await;
        if let Some(prev) = map.remove(&scope) {
            let _ = prev.stop_tx.try_send(());
            prev.task.abort();
        }
    }

    /// Stops all active watchers for shutdown cleanup.
    pub async fn unwatch_all(&self) {
        let mut map = self.scopes.lock().await;
        for (_, prev) in map.drain() {
            let _ = prev.stop_tx.try_send(());
            prev.task.abort();
        }
    }
}

enum RawWatchSignal {
    Event(notify::Result<Event>),
}

fn build_notify_watcher(
    root: &Path,
    tx: mpsc::UnboundedSender<RawWatchSignal>,
) -> Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(RawWatchSignal::Event(res));
    })
    .context("Failed to initialize native directory watcher")?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .with_context(|| format!("Failed to watch workspace directory {}", root.display()))?;
    Ok(watcher)
}

fn spawn_scope_watcher(
    scope: WatchScope,
    callback: WatchCallback,
    mut stop_rx: mpsc::Receiver<()>,
) -> Result<JoinHandle<()>> {
    let (raw_tx, mut raw_rx) = mpsc::unbounded_channel();
    let initial_watcher = build_notify_watcher(&scope.root_path, raw_tx.clone())?;

    let handle = tokio::spawn(async move {
        let mut _watcher: Option<RecommendedWatcher> = Some(initial_watcher);
        let mut pending_paths: HashSet<PathBuf> = HashSet::new();
        let mut saw_remove = false;
        let mut debounce_sleep: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        let mut restart_attempt: usize = 0;
        let mut last_restart_at: Option<Instant> = None;

        loop {
            tokio::select! {
                _ = stop_rx.recv() => {
                    break;
                }
                signal = raw_rx.recv() => {
                    let Some(RawWatchSignal::Event(res)) = signal else {
                        break;
                    };
                    match res {
                        Ok(event) => {
                            if let Some(since) = last_restart_at
                                && since.elapsed() >= WATCH_HEALTHY_RESET
                            {
                                restart_attempt = 0;
                                last_restart_at = None;
                            }
                            if matches!(event.kind, EventKind::Remove(_)) {
                                saw_remove = true;
                            }
                            for p in event.paths {
                                pending_paths.insert(p);
                            }
                            if debounce_sleep.is_none() && !pending_paths.is_empty() {
                                debounce_sleep = Some(Box::pin(tokio::time::sleep(DEFAULT_WATCH_DEBOUNCE)));
                            }
                        }
                        Err(_) => {
                            _watcher = None;
                            if restart_attempt < WATCH_RESTART_DELAYS.len() {
                                let delay = WATCH_RESTART_DELAYS[restart_attempt];
                                restart_attempt += 1;
                                tokio::time::sleep(delay).await;
                                if let Ok(rebuilt) = build_notify_watcher(&scope.root_path, raw_tx.clone()) {
                                    _watcher = Some(rebuilt);
                                    last_restart_at = Some(Instant::now());
                                    continue;
                                }
                            }
                            callback(WorkspaceWatchBatch {
                                workspace_id: scope.workspace_id.clone(),
                                root_path: scope.root_path.clone(),
                                paths: vec![],
                                affected_dirs: vec![scope.root_path.clone()],
                                kind: WatchChangeKind::Error,
                            });
                            break;
                        }
                    }
                }
                _ = async {
                    if let Some(sleep) = debounce_sleep.as_mut() {
                        sleep.as_mut().await;
                    }
                }, if debounce_sleep.is_some() => {
                    debounce_sleep = None;
                    if !pending_paths.is_empty() {
                        let paths: Vec<PathBuf> = pending_paths.drain().collect();
                        let mut affected_dirs: HashSet<PathBuf> = HashSet::new();
                        for p in &paths {
                            if let Some(parent) = p.parent() {
                                affected_dirs.insert(parent.to_path_buf());
                            }
                        }
                        if affected_dirs.is_empty() {
                            affected_dirs.insert(scope.root_path.clone());
                        }
                        let kind = if saw_remove {
                            WatchChangeKind::Removed
                        } else {
                            WatchChangeKind::Changed
                        };
                        saw_remove = false;
                        callback(WorkspaceWatchBatch {
                            workspace_id: scope.workspace_id.clone(),
                            root_path: scope.root_path.clone(),
                            paths,
                            affected_dirs: affected_dirs.into_iter().collect(),
                            kind,
                        });
                    }
                }
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn emits_debounced_batch_when_workspace_file_changes() {
        let ws = tempdir().unwrap();
        let watcher = WorkspaceDirectoryWatcher::new();
        let (tx, mut rx) = mpsc::unbounded_channel();

        watcher
            .watch(
                "ws-1",
                ws.path(),
                Arc::new(move |batch| {
                    let _ = tx.send(batch);
                }),
            )
            .await
            .unwrap();

        tokio::time::sleep(Duration::from_millis(50)).await;
        let file = ws.path().join("changed.txt");
        std::fs::write(&file, "hello").unwrap();

        let batch = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("watcher should deliver event before timeout")
            .expect("channel should remain open");
        assert_eq!(batch.workspace_id, "ws-1");
        assert!(!batch.paths.is_empty());

        watcher.unwatch_all().await;
    }
}
