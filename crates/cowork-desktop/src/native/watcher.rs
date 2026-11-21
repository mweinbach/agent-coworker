//! Recursive workspace directory watcher with debounced path aggregation and bounded
//! backoff restarts, mirroring `apps/desktop/electron/services/workspaceDirectoryWatcher.ts`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use cowork_config::canonicalize_sync;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::{Mutex, mpsc, oneshot};
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

type WatchHandle = Box<dyn Send + Sync>;
type WatchBackendFactory =
    Arc<dyn Fn(&Path, mpsc::UnboundedSender<RawWatchSignal>) -> Result<WatchHandle> + Send + Sync>;

#[derive(Clone)]
struct WatcherConfig {
    debounce: Duration,
    restart_delays: Vec<Duration>,
    healthy_reset: Duration,
    factory: WatchBackendFactory,
}

impl WatcherConfig {
    fn production() -> Self {
        Self {
            debounce: DEFAULT_WATCH_DEBOUNCE,
            restart_delays: WATCH_RESTART_DELAYS.to_vec(),
            healthy_reset: WATCH_HEALTHY_RESET,
            factory: Arc::new(|root, tx| {
                let watcher = build_notify_watcher(root, tx)?;
                Ok(Box::new(watcher))
            }),
        }
    }
}

struct ActiveScope {
    task: JoinHandle<()>,
    stop_tx: Option<oneshot::Sender<()>>,
}

/// Drops the underlying OS watcher off the Tokio executor thread so blocking
/// backends (such as macOS `FSEvents` thread joins) never stall async tasks.
struct OffThreadWatchHandle(Option<WatchHandle>);

impl Drop for OffThreadWatchHandle {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            if let Ok(rt) = tokio::runtime::Handle::try_current() {
                drop(rt.spawn_blocking(move || drop(handle)));
            } else {
                drop(handle);
            }
        }
    }
}

/// Manages debounced recursive filesystem watchers keyed by `(workspace_id, root_path)`.
#[derive(Clone)]
pub struct WorkspaceDirectoryWatcher {
    scopes: Arc<Mutex<HashMap<WatchScope, ActiveScope>>>,
    config: WatcherConfig,
}

impl Default for WorkspaceDirectoryWatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceDirectoryWatcher {
    pub fn new() -> Self {
        Self::with_config(WatcherConfig::production())
    }

    fn with_config(config: WatcherConfig) -> Self {
        Self {
            scopes: Arc::new(Mutex::new(HashMap::new())),
            config,
        }
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

        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let task =
            spawn_scope_watcher(scope.clone(), callback, stop_rx, self.config.clone()).await?;

        let prev = {
            let mut map = self.scopes.lock().await;
            map.insert(
                scope,
                ActiveScope {
                    task,
                    stop_tx: Some(stop_tx),
                },
            )
        };
        if let Some(prev) = prev {
            stop_scope_task(prev).await;
        }
        Ok(())
    }

    /// Stops watching a previously registered `(workspace_id, root_path)` scope.
    pub async fn unwatch(&self, workspace_id: &str, root_path: &Path) {
        let scope = WatchScope {
            workspace_id: workspace_id.to_string(),
            root_path: canonicalize_sync(root_path),
        };
        let prev = {
            let mut map = self.scopes.lock().await;
            map.remove(&scope)
        };
        if let Some(prev) = prev {
            stop_scope_task(prev).await;
        }
    }

    /// Stops all active watchers for shutdown cleanup.
    pub async fn unwatch_all(&self) {
        let drained: Vec<ActiveScope> = {
            let mut map = self.scopes.lock().await;
            map.drain().map(|(_, scope)| scope).collect()
        };
        for scope in drained {
            stop_scope_task(scope).await;
        }
    }
}

async fn stop_scope_task(mut scope: ActiveScope) {
    if let Some(tx) = scope.stop_tx.take() {
        let _ = tx.send(());
    }
    let _ = scope.task.await;
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

async fn create_watch_handle_off_thread(
    factory: WatchBackendFactory,
    root: PathBuf,
    tx: mpsc::UnboundedSender<RawWatchSignal>,
) -> Result<WatchHandle> {
    tokio::task::spawn_blocking(move || (factory)(&root, tx))
        .await
        .context("Watch backend builder panicked")?
}

async fn spawn_scope_watcher(
    scope: WatchScope,
    callback: WatchCallback,
    mut stop_rx: oneshot::Receiver<()>,
    config: WatcherConfig,
) -> Result<JoinHandle<()>> {
    let (raw_tx, mut raw_rx) = mpsc::unbounded_channel();
    let initial_handle = create_watch_handle_off_thread(
        Arc::clone(&config.factory),
        scope.root_path.clone(),
        raw_tx.clone(),
    )
    .await?;

    let handle = tokio::spawn(async move {
        let mut _watcher = OffThreadWatchHandle(Some(initial_handle));
        let mut pending_paths: HashSet<PathBuf> = HashSet::new();
        let mut saw_remove = false;
        let mut debounce_sleep: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
        let mut restart_attempt: usize = 0;
        let mut last_restart_at: Option<Instant> = None;

        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    break;
                }
                signal = raw_rx.recv() => {
                    let Some(RawWatchSignal::Event(res)) = signal else {
                        break;
                    };
                    match res {
                        Ok(event) => {
                            if let Some(since) = last_restart_at
                                && since.elapsed() >= config.healthy_reset
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
                                debounce_sleep = Some(Box::pin(tokio::time::sleep(config.debounce)));
                            }
                        }
                        Err(_) => {
                            _watcher = OffThreadWatchHandle(None);
                            let mut restarted = false;
                            while restart_attempt < config.restart_delays.len() {
                                let delay = config.restart_delays[restart_attempt];
                                restart_attempt += 1;
                                tokio::select! {
                                    _ = &mut stop_rx => {
                                        return;
                                    }
                                    _ = tokio::time::sleep(delay) => {}
                                }
                                if let Ok(rebuilt) = create_watch_handle_off_thread(
                                    Arc::clone(&config.factory),
                                    scope.root_path.clone(),
                                    raw_tx.clone(),
                                )
                                .await
                                {
                                    _watcher = OffThreadWatchHandle(Some(rebuilt));
                                    last_restart_at = Some(Instant::now());
                                    restarted = true;
                                    break;
                                }
                            }
                            if restarted {
                                continue;
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use tempfile::tempdir;

    use super::*;

    struct DropCounter(Arc<AtomicUsize>);
    impl Drop for DropCounter {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn emits_debounced_batch_when_workspace_file_changes() {
        let ws = tempdir().unwrap();
        let root_canon = canonicalize_sync(ws.path());
        let signal_tx_slot: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<RawWatchSignal>>>> =
            Arc::new(std::sync::Mutex::new(None));
        let dropped = Arc::new(AtomicUsize::new(0));

        let factory_slot = Arc::clone(&signal_tx_slot);
        let factory_dropped = Arc::clone(&dropped);
        let watcher = WorkspaceDirectoryWatcher::with_config(WatcherConfig {
            debounce: Duration::from_millis(15),
            restart_delays: vec![Duration::from_millis(5)],
            healthy_reset: Duration::from_secs(60),
            factory: Arc::new(move |_root, tx| {
                *factory_slot.lock().unwrap() = Some(tx);
                Ok(Box::new(DropCounter(Arc::clone(&factory_dropped))))
            }),
        });

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

        let signal_tx = signal_tx_slot.lock().unwrap().clone().unwrap();
        let file_a = root_canon.join("src").join("a.txt");
        let file_b = root_canon.join("src").join("b.txt");
        signal_tx
            .send(RawWatchSignal::Event(Ok(Event::new(EventKind::Create(
                CreateKind::File,
            ))
            .add_path(file_a.clone()))))
            .unwrap();
        signal_tx
            .send(RawWatchSignal::Event(Ok(Event::new(EventKind::Modify(
                ModifyKind::Any,
            ))
            .add_path(file_a.clone()))))
            .unwrap();
        signal_tx
            .send(RawWatchSignal::Event(Ok(Event::new(EventKind::Modify(
                ModifyKind::Any,
            ))
            .add_path(file_b.clone()))))
            .unwrap();

        let batch = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("watcher should deliver debounced batch before timeout")
            .expect("channel should remain open");
        assert_eq!(batch.workspace_id, "ws-1");
        assert_eq!(batch.kind, WatchChangeKind::Changed);
        assert_eq!(batch.paths.len(), 2);
        assert!(batch.paths.contains(&file_a));
        assert!(batch.paths.contains(&file_b));
        assert_eq!(batch.affected_dirs, vec![root_canon.join("src")]);

        // Removing a file classifies the next coalesced batch as Removed.
        signal_tx
            .send(RawWatchSignal::Event(Ok(Event::new(EventKind::Remove(
                RemoveKind::File,
            ))
            .add_path(file_a.clone()))))
            .unwrap();
        let remove_batch = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("watcher should deliver remove batch before timeout")
            .expect("channel should remain open");
        assert_eq!(remove_batch.kind, WatchChangeKind::Removed);
        assert_eq!(remove_batch.paths, vec![file_a]);

        watcher.unwatch_all().await;
        // DropCounter runs on spawn_blocking; yield briefly so drop completes deterministically.
        for _ in 0..50 {
            if dropped.load(Ordering::SeqCst) == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn restarts_on_error_with_bounded_backoff_and_cancels_cleanly_on_unwatch() {
        let ws = tempdir().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let signal_tx_slot: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<RawWatchSignal>>>> =
            Arc::new(std::sync::Mutex::new(None));

        let factory_attempts = Arc::clone(&attempts);
        let factory_slot = Arc::clone(&signal_tx_slot);
        let watcher = WorkspaceDirectoryWatcher::with_config(WatcherConfig {
            debounce: Duration::from_millis(10),
            restart_delays: vec![Duration::from_millis(5), Duration::from_millis(5)],
            healthy_reset: Duration::from_secs(60),
            factory: Arc::new(move |_root, tx| {
                let n = factory_attempts.fetch_add(1, Ordering::SeqCst);
                *factory_slot.lock().unwrap() = Some(tx);
                if n == 1 {
                    anyhow::bail!("transient rebuild failure");
                }
                Ok(Box::new(()))
            }),
        });

        let (tx, mut rx) = mpsc::unbounded_channel();
        watcher
            .watch(
                "ws-err",
                ws.path(),
                Arc::new(move |batch| {
                    let _ = tx.send(batch);
                }),
            )
            .await
            .unwrap();

        // Trigger first watcher error -> retry #1 fails -> retry #2 succeeds (`attempts == 3`).
        let first_tx = signal_tx_slot.lock().unwrap().clone().unwrap();
        first_tx
            .send(RawWatchSignal::Event(Err(notify::Error::generic("boom"))))
            .unwrap();

        for _ in 0..100 {
            if attempts.load(Ordering::SeqCst) == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 3);

        // Once retry budget is exhausted, an Error batch is emitted.
        let latest_tx = signal_tx_slot.lock().unwrap().clone().unwrap();
        latest_tx
            .send(RawWatchSignal::Event(Err(notify::Error::generic("fatal"))))
            .unwrap();
        let err_batch = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("watcher should emit Error batch once retries exhaust")
            .expect("channel should remain open");
        assert_eq!(err_batch.kind, WatchChangeKind::Error);

        // Replacement watch + immediate unwatch during backoff cancels without waiting.
        let stalling_watcher = WorkspaceDirectoryWatcher::with_config(WatcherConfig {
            debounce: Duration::from_millis(10),
            restart_delays: vec![Duration::from_secs(30)],
            healthy_reset: Duration::from_secs(60),
            factory: Arc::new(move |_root, tx| {
                let _ = tx.send(RawWatchSignal::Event(Err(notify::Error::generic("boom"))));
                Ok(Box::new(()))
            }),
        });
        stalling_watcher
            .watch("ws-stop", ws.path(), Arc::new(|_| {}))
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            stalling_watcher.unwatch("ws-stop", ws.path()),
        )
        .await
        .expect("unwatch should cancel backoff sleep immediately");
    }
}
