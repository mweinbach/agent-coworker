use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

use cowork_config::canonicalize_sync;
use ignore::{WalkBuilder, WalkState};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind};
use parking_lot::Mutex;

use crate::env_utils::host_platform;
use crate::policy::canonical_tmp_alias;

/// Metadata directory/file names inside writable roots that MUST remain read-only in sandboxes.
pub const PROTECTED_SUBDIRS: [&str; 2] = [".git", ".cowork"];

/// Returns whether `platform` uses case-insensitive filesystem matching by default.
pub fn platform_is_case_insensitive(platform: &str) -> bool {
    matches!(platform, "darwin" | "win32")
}

/// Checks whether a path segment matches `.git` or `.cowork` under the given case-sensitivity rule.
pub fn is_protected_metadata_name(name: &str, case_insensitive: bool) -> bool {
    if case_insensitive {
        PROTECTED_SUBDIRS
            .iter()
            .any(|p| name.eq_ignore_ascii_case(p))
    } else {
        PROTECTED_SUBDIRS.contains(&name)
    }
}

/// Telemetry counters exposed by `WorkspaceProtectedPathsCache` to prove zero redundant
/// full-workspace walks occur across repeated `bash`/sandbox command invocations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtectedPathsCacheStats {
    pub initial_scans: usize,
    pub dirs_walked: usize,
    pub cache_hits: usize,
    pub notify_events_processed: usize,
}

struct WatchedRootEntry {
    canonical_root: PathBuf,
    /// Case-insensitive superset of all non-symlink `.git` / `.cowork` files and directories
    /// under `canonical_root`. Case-sensitive queries (`linux`) filter the final segment.
    candidates: BTreeSet<PathBuf>,
    rx: Option<mpsc::Receiver<notify::Result<Event>>>,
    _watcher: Option<RecommendedWatcher>,
}

/// Cached `.git` / `.cowork` subpath discovery backed by `ignore::WalkBuilder` + `notify`.
///
/// Eliminates the synchronous `O(workspace)` `readdirSync` walk before every `bash` command while
/// keeping nested submodule/worktree `.git` and `.cowork` write exclusions up to date.
pub struct WorkspaceProtectedPathsCache {
    entries: Mutex<HashMap<PathBuf, WatchedRootEntry>>,
    initial_scans: AtomicUsize,
    dirs_walked: AtomicUsize,
    cache_hits: AtomicUsize,
    notify_events_processed: AtomicUsize,
}

impl Default for WorkspaceProtectedPathsCache {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceProtectedPathsCache {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            initial_scans: AtomicUsize::new(0),
            dirs_walked: AtomicUsize::new(0),
            cache_hits: AtomicUsize::new(0),
            notify_events_processed: AtomicUsize::new(0),
        }
    }

    /// Returns current cache instrumentation counters.
    pub fn stats(&self) -> ProtectedPathsCacheStats {
        ProtectedPathsCacheStats {
            initial_scans: self.initial_scans.load(Ordering::Acquire),
            dirs_walked: self.dirs_walked.load(Ordering::Acquire),
            cache_hits: self.cache_hits.load(Ordering::Acquire),
            notify_events_processed: self.notify_events_processed.load(Ordering::Acquire),
        }
    }

    /// Invalidates a specific root (or all roots containing `path`) from the cache.
    pub fn invalidate(&self, path: &Path) {
        let canon = canonicalize_sync(path);
        let mut guard = self.entries.lock();
        guard.retain(|root, _| {
            !(root == &canon || is_lexical_inside(root, &canon) || is_lexical_inside(&canon, root))
        });
    }

    /// Clears all watched roots and resets cache entries.
    pub fn clear(&self) {
        self.entries.lock().clear();
    }

    /// Returns all existing `.git` and `.cowork` directories and files (direct + nested) inside
    /// `roots`, populating any unseen root via `ignore::WalkBuilder` once and maintaining it
    /// incrementally via `notify`.
    pub fn protected_paths_for_roots(
        &self,
        roots: &[PathBuf],
        platform_override: Option<&str>,
    ) -> Vec<PathBuf> {
        let platform = platform_override.unwrap_or(host_platform());
        let case_insensitive = platform_is_case_insensitive(platform);

        let mut canonical_roots: Vec<PathBuf> = Vec::new();
        for root in roots {
            let Ok(meta) = std::fs::metadata(root) else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let canon = canonicalize_sync(root);
            if !canonical_roots.contains(&canon) {
                canonical_roots.push(canon);
            }
        }
        // Sort ancestor-first so a parent workspace root covers nested roots without a second walk.
        canonical_roots.sort_by_key(|p| p.as_os_str().len());

        let mut out_seen: HashSet<String> = HashSet::new();
        let mut out: Vec<PathBuf> = Vec::new();

        let mut guard = self.entries.lock();
        // Drain pending watcher events on all active entries first.
        for entry in guard.values_mut() {
            self.drain_entry_events(entry);
        }

        for root in canonical_roots {
            // Check if `root` itself or an ancestor of `root` is already cached & non-symlink.
            let covering_root = guard
                .keys()
                .find(|cached| {
                    *cached == &root
                        || (is_lexical_inside(cached, &root)
                            && is_valid_nonsymlink_dir_descendant(cached, &root))
                })
                .cloned();

            if let Some(covered_by) = covering_root {
                self.cache_hits.fetch_add(1, Ordering::AcqRel);
                if let Some(entry) = guard.get(&covered_by) {
                    collect_filtered_candidates(
                        &entry.candidates,
                        &root,
                        case_insensitive,
                        &mut out_seen,
                        &mut out,
                    );
                }
                continue;
            }

            // Initial scan via `ignore::WalkBuilder` + start `notify::RecommendedWatcher`.
            let entry = self.populate_root_entry(&root);
            collect_filtered_candidates(
                &entry.candidates,
                &root,
                case_insensitive,
                &mut out_seen,
                &mut out,
            );
            guard.insert(root, entry);
        }

        out
    }

    /// Polls until a newly created/removed path change is reflected by `notify` (up to `timeout`),
    /// useful in tests exercising asynchronous OS watcher backends such as macOS FSEvents.
    pub fn wait_for_protected_path(
        &self,
        roots: &[PathBuf],
        expected_path: &Path,
        should_exist: bool,
        platform_override: Option<&str>,
        timeout: Duration,
    ) -> bool {
        let expected_canon = canonicalize_sync(expected_path);
        let deadline = Instant::now() + timeout;
        loop {
            let current = self.protected_paths_for_roots(roots, platform_override);
            let present = current
                .iter()
                .any(|p| p == expected_path || p == &expected_canon);
            if present == should_exist {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    fn populate_root_entry(&self, canonical_root: &Path) -> WatchedRootEntry {
        // Attach watcher BEFORE walking so mutations racing with the initial scan are queued in `rx`
        // and never missed between scan completion and watch registration!
        let (tx, rx) = mpsc::channel();
        let watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .ok()
        .and_then(|mut w| {
            w.watch(canonical_root, RecursiveMode::Recursive)
                .ok()
                .map(|()| w)
        });

        self.initial_scans.fetch_add(1, Ordering::AcqRel);
        let candidates = scan_protected_subpaths_parallel(canonical_root, &self.dirs_walked);

        let mut entry = WatchedRootEntry {
            canonical_root: canonical_root.to_path_buf(),
            candidates,
            rx: if watcher.is_some() { Some(rx) } else { None },
            _watcher: watcher,
        };
        self.drain_entry_events(&mut entry);
        entry
    }

    fn drain_entry_events(&self, entry: &mut WatchedRootEntry) {
        let Some(rx) = entry.rx.as_ref() else {
            return;
        };
        let mut events = Vec::new();
        while let Ok(res) = rx.try_recv() {
            if let Ok(ev) = res {
                events.push(ev);
            }
        }
        if events.is_empty() {
            return;
        }
        self.notify_events_processed
            .fetch_add(events.len(), Ordering::AcqRel);

        for ev in events {
            if ev.need_rescan() {
                entry.candidates =
                    scan_protected_subpaths_parallel(&entry.canonical_root, &self.dirs_walked);
                continue;
            }
            for raw_path in &ev.paths {
                let mapped = map_event_path_to_root(&entry.canonical_root, raw_path);
                let Some(ev_path) = mapped else {
                    continue;
                };

                // 1. Prune any cached candidate under or equal to `ev_path` that was removed or
                // turned into a symlink.
                entry.candidates.retain(|cand| {
                    if cand == &ev_path
                        || is_lexical_inside(&ev_path, cand)
                        || is_lexical_inside(cand, &ev_path)
                    {
                        is_valid_nonsymlink_descendant(&entry.canonical_root, cand)
                    } else {
                        true
                    }
                });

                if ev_path == entry.canonical_root {
                    continue;
                }

                // 2. Check if `ev_path` itself crosses a `.git` / `.cowork` segment relative to `canonical_root`.
                if let Some(protected_prefix) =
                    first_protected_descendant_prefix(&entry.canonical_root, &ev_path)
                {
                    if is_valid_nonsymlink_descendant(&entry.canonical_root, &protected_prefix) {
                        entry.candidates.insert(protected_prefix);
                    }
                    continue;
                }

                // 3. If a directory was newly created or moved/renamed into the workspace, scan just
                // that subtree (never the whole workspace!) so pre-populated nested `.git`/`.cowork`
                // dirs moved in via `mv` are immediately protected.
                let is_structural_dir_change = matches!(
                    ev.kind,
                    EventKind::Create(_)
                        | EventKind::Modify(ModifyKind::Name(_))
                        | EventKind::Any
                        | EventKind::Other
                );
                if is_structural_dir_change
                    && is_valid_nonsymlink_dir_descendant(&entry.canonical_root, &ev_path)
                {
                    let nested = scan_protected_subpaths_parallel(&ev_path, &self.dirs_walked);
                    entry.candidates.extend(nested);
                }
            }
        }
    }
}

/// Shared process-wide `WorkspaceProtectedPathsCache`.
pub fn global_protected_paths_cache() -> &'static Arc<WorkspaceProtectedPathsCache> {
    static GLOBAL_CACHE: OnceLock<Arc<WorkspaceProtectedPathsCache>> = OnceLock::new();
    GLOBAL_CACHE.get_or_init(|| Arc::new(WorkspaceProtectedPathsCache::new()))
}

/// Optional predicates for synthetic unit tests of `protected_metadata_paths_with_options`.
#[derive(Default)]
pub struct ProtectedMetadataOptions<'a> {
    pub platform: Option<&'a str>,
    pub exists: Option<&'a dyn Fn(&Path) -> bool>,
    pub is_directory: Option<&'a dyn Fn(&Path) -> bool>,
    pub cache: Option<&'a WorkspaceProtectedPathsCache>,
}

/// Discovers existing `.git` and `.cowork` directories and files (direct + nested) inside `roots`.
///
/// Uses `opts.cache` (or an uncached `ignore::WalkBuilder` scan when `opts.cache` is `None` and no
/// synthetic predicates are supplied). `SandboxManager` always supplies its `WorkspaceProtectedPathsCache`.
pub fn protected_metadata_paths(
    roots: &[PathBuf],
    opts: ProtectedMetadataOptions<'_>,
) -> Vec<PathBuf> {
    let platform = opts.platform.unwrap_or(host_platform());
    let case_insensitive = platform_is_case_insensitive(platform);

    // Synthetic predicate path for unit tests mocking `exists` / `is_directory`.
    if opts.exists.is_some() || opts.is_directory.is_some() {
        let exists_fn = opts
            .exists
            .unwrap_or(&|p: &Path| std::fs::symlink_metadata(p).is_ok());
        let is_dir_fn = opts
            .is_directory
            .unwrap_or(&|p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()));
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for root in roots {
            for sub in PROTECTED_SUBDIRS {
                let candidate = root.join(sub);
                if exists_fn(&candidate) {
                    push_dedup(&candidate, case_insensitive, &mut seen, &mut out);
                }
            }
            if is_dir_fn(root) && std::fs::symlink_metadata(root).is_ok_and(|m| m.is_dir()) {
                let dummy = AtomicUsize::new(0);
                let scanned = scan_protected_subpaths_parallel(root, &dummy);
                for cand in scanned {
                    if matches_platform_case(&cand, case_insensitive) && exists_fn(&cand) {
                        push_dedup(&cand, case_insensitive, &mut seen, &mut out);
                    }
                }
            }
        }
        return out;
    }

    if let Some(cache) = opts.cache {
        return cache.protected_paths_for_roots(roots, Some(platform));
    }

    // One-shot `ignore::WalkBuilder` scan when called without a cache instance.
    let dummy_counter = AtomicUsize::new(0);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        let Ok(meta) = std::fs::metadata(root) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let canon = canonicalize_sync(root);
        let candidates = scan_protected_subpaths_parallel(&canon, &dummy_counter);
        collect_filtered_candidates(&candidates, &canon, case_insensitive, &mut seen, &mut out);
    }
    out
}

fn scan_protected_subpaths_parallel(root: &Path, dirs_walked: &AtomicUsize) -> BTreeSet<PathBuf> {
    let found: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
    let mut builder = WalkBuilder::new(root);
    builder
        .follow_links(false)
        .hidden(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .ignore(false)
        .parents(false)
        .same_file_system(false);

    builder.build_parallel().run(|| {
        let found_ref = &found;
        Box::new(move |entry_res| {
            let Ok(entry) = entry_res else {
                return WalkState::Continue;
            };
            if entry.depth() == 0 {
                dirs_walked.fetch_add(1, Ordering::Relaxed);
                return WalkState::Continue;
            }
            if entry.path_is_symlink() {
                return WalkState::Skip;
            }
            let name = entry.file_name().to_string_lossy();
            if is_protected_metadata_name(&name, true) {
                found_ref.lock().insert(entry.path().to_path_buf());
                return WalkState::Skip;
            }
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                dirs_walked.fetch_add(1, Ordering::Relaxed);
            }
            WalkState::Continue
        })
    });

    found.into_inner()
}

fn collect_filtered_candidates(
    candidates: &BTreeSet<PathBuf>,
    query_root: &Path,
    case_insensitive: bool,
    seen: &mut HashSet<String>,
    out: &mut Vec<PathBuf>,
) {
    for cand in candidates {
        if !is_strictly_inside(query_root, cand) {
            continue;
        }
        if !matches_platform_case(cand, case_insensitive) {
            continue;
        }
        push_dedup(cand, case_insensitive, seen, out);
    }
}

fn matches_platform_case(cand: &Path, case_insensitive: bool) -> bool {
    let Some(name) = cand.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    is_protected_metadata_name(name, case_insensitive)
}

fn push_dedup(
    cand: &Path,
    case_insensitive: bool,
    seen: &mut HashSet<String>,
    out: &mut Vec<PathBuf>,
) {
    let raw = cand.to_string_lossy();
    let key = if case_insensitive {
        raw.to_ascii_lowercase()
    } else {
        raw.into_owned()
    };
    if seen.insert(key) {
        out.push(cand.to_path_buf());
    }
}

fn map_event_path_to_root(canonical_root: &Path, raw_path: &Path) -> Option<PathBuf> {
    if raw_path == canonical_root || is_lexical_inside(canonical_root, raw_path) {
        return Some(raw_path.to_path_buf());
    }
    let aliased_root = canonical_tmp_alias(canonical_root);
    let aliased_raw = canonical_tmp_alias(raw_path);
    if aliased_raw == aliased_root {
        return Some(canonical_root.to_path_buf());
    }
    if let Ok(rel) = aliased_raw.strip_prefix(&aliased_root) {
        return Some(canonical_root.join(rel));
    }
    None
}

fn first_protected_descendant_prefix(canonical_root: &Path, ev_path: &Path) -> Option<PathBuf> {
    let rel = ev_path.strip_prefix(canonical_root).ok()?;
    let mut cur = canonical_root.to_path_buf();
    for comp in rel.components() {
        let Component::Normal(os) = comp else {
            return None;
        };
        cur.push(os);
        let name = os.to_string_lossy();
        if is_protected_metadata_name(&name, true) {
            return Some(cur);
        }
    }
    None
}

fn is_valid_nonsymlink_descendant(canonical_root: &Path, target: &Path) -> bool {
    let Ok(rel) = target.strip_prefix(canonical_root) else {
        return false;
    };
    if rel.as_os_str().is_empty() {
        return false;
    }
    let mut cur = canonical_root.to_path_buf();
    for comp in rel.components() {
        let Component::Normal(os) = comp else {
            return false;
        };
        cur.push(os);
        let Ok(meta) = std::fs::symlink_metadata(&cur) else {
            return false;
        };
        if meta.file_type().is_symlink() {
            return false;
        }
    }
    true
}

fn is_valid_nonsymlink_dir_descendant(canonical_root: &Path, target: &Path) -> bool {
    if !is_valid_nonsymlink_descendant(canonical_root, target) {
        return false;
    }
    std::fs::symlink_metadata(target).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink())
}

fn is_lexical_inside(root: &Path, target: &Path) -> bool {
    target == root || target.strip_prefix(root).is_ok()
}

fn is_strictly_inside(root: &Path, target: &Path) -> bool {
    target != root && target.strip_prefix(root).is_ok()
}
