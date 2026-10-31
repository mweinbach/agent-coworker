use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use chrono::Utc;
use cowork_config::{
    FileLockOptions, file_lock_root_for_cowork_home, harden_private_file_sync, with_file_lock_sync,
    write_text_file_atomic,
};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;

use crate::extensions::types::SkillMutationSignal;

pub struct SkillMutationBus {
    user_cowork_dir: PathBuf,
    revision: Arc<AtomicU64>,
    last_token: Arc<Mutex<Option<String>>>,
    stopped: Arc<AtomicBool>,
    watched_dirs: Mutex<BTreeSet<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    callback: Arc<dyn Fn(u64) + Send + Sync>,
}

impl SkillMutationBus {
    pub fn start<F>(
        user_cowork_dir: &Path,
        initial_dirs: &[PathBuf],
        on_change: F,
    ) -> Result<Arc<Self>, String>
    where
        F: Fn(u64) + Send + Sync + 'static,
    {
        fs::create_dir_all(user_cowork_dir.join("locks"))
            .map_err(|e| format!("failed creating locks dir: {e}"))?;

        let (initial_token, initial_num) = read_signal_state(user_cowork_dir);
        let revision = Arc::new(AtomicU64::new(initial_num));
        let last_token = Arc::new(Mutex::new(initial_token));
        let stopped = Arc::new(AtomicBool::new(false));
        let callback: Arc<dyn Fn(u64) + Send + Sync> = Arc::new(on_change);

        let rev_for_watcher = Arc::clone(&revision);
        let token_for_watcher = Arc::clone(&last_token);
        let stopped_for_watcher = Arc::clone(&stopped);
        let cb_for_watcher = Arc::clone(&callback);
        let user_dir_for_watcher = user_cowork_dir.to_path_buf();

        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if stopped_for_watcher.load(Ordering::SeqCst) {
                return;
            }
            let Ok(event) = res else {
                return;
            };
            let is_signal_only = !event.paths.is_empty()
                && event.paths.iter().all(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy() == "shared-skill-mutation.json")
                        .unwrap_or(false)
                });
            let relevant = event.paths.iter().any(|p| {
                let name = p
                    .file_name()
                    .map(|n| n.to_string_lossy())
                    .unwrap_or_default();
                if name.ends_with(".lock")
                    || name.ends_with(".sqlite")
                    || name.ends_with("-wal")
                    || name.ends_with("-shm")
                    || name.starts_with(".incoming-")
                    || name.contains(".tmp.")
                {
                    return false;
                }
                name == "shared-skill-mutation.json"
                    || name == "SKILL.md"
                    || name == "openai.yaml"
                    || name == "plugin.json"
                    || name == "plugins.json"
                    || name == "marketplaces.json"
                    || name == ".mcp.json"
                    || p.components().any(|c| {
                        let s = c.as_os_str().to_string_lossy();
                        s == "skills" || s == "disabled-skills" || s == "plugins"
                    })
            });
            if !relevant {
                return;
            }
            let (disk_tok, disk_rev) = read_signal_state(&user_dir_for_watcher);
            if is_signal_only && let Some(ref dt) = disk_tok {
                let mut guard = token_for_watcher.lock();
                if guard.as_deref() == Some(dt.as_str()) {
                    return;
                }
                *guard = Some(dt.clone());
            } else if let Some(dt) = disk_tok {
                *token_for_watcher.lock() = Some(dt);
            }
            let next = rev_for_watcher
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| {
                    Some(cur.max(disk_rev).saturating_add(1))
                })
                .map(|prev| prev.max(disk_rev).saturating_add(1))
                .unwrap_or(1);
            (cb_for_watcher)(next);
        })
        .map_err(|e| format!("failed starting skill notify watcher: {e}"))?;

        let bus = Arc::new(Self {
            user_cowork_dir: user_cowork_dir.to_path_buf(),
            revision,
            last_token,
            stopped,
            watched_dirs: Mutex::new(BTreeSet::new()),
            watcher: Mutex::new(Some(watcher)),
            callback,
        });

        bus.watch_dir(user_cowork_dir);
        bus.watch_dir(&user_cowork_dir.join("locks"));
        bus.watch_dir(&user_cowork_dir.join("skills"));
        bus.watch_dir(&user_cowork_dir.join("disabled-skills"));
        bus.watch_dir(&user_cowork_dir.join("plugins"));
        for d in initial_dirs {
            bus.watch_dir(d);
        }

        Ok(bus)
    }

    pub fn watch_workspace(&self, workspace_dir: &Path) {
        self.watch_dir(&workspace_dir.join(".cowork/skills"));
        self.watch_dir(&workspace_dir.join(".cowork/disabled-skills"));
        self.watch_dir(&workspace_dir.join(".cowork/plugins"));
        self.watch_dir(&workspace_dir.join(".agents/skills"));
        self.watch_dir(&workspace_dir.join(".claude/skills"));
    }

    pub fn watch_dir(&self, dir: &Path) {
        let target = if dir.exists() {
            dir.to_path_buf()
        } else if let Some(parent) = dir.parent().filter(|p| p.exists()) {
            parent.to_path_buf()
        } else {
            return;
        };
        let mut set = self.watched_dirs.lock();
        if !set.insert(target.clone()) {
            return;
        }
        if let Some(ref mut watcher) = *self.watcher.lock() {
            let mode = if target == self.user_cowork_dir {
                RecursiveMode::NonRecursive
            } else {
                RecursiveMode::Recursive
            };
            let _ = watcher.watch(&target, mode);
        }
    }

    /// Atomically bumps `shared-skill-mutation.json` (in both `<userCoworkDir>` and `<userCoworkDir>/locks`)
    /// and notifies local subscribers immediately.
    pub fn publish_mutation(&self) -> Result<u64, String> {
        let primary = self.user_cowork_dir.join("shared-skill-mutation.json");
        let mirror = self
            .user_cowork_dir
            .join("locks/shared-skill-mutation.json");
        let lock_root = file_lock_root_for_cowork_home(&self.user_cowork_dir);
        let user_dir = self.user_cowork_dir.clone();

        let (next_rev, next_tok) =
            with_file_lock_sync::<(u64, String), cowork_config::ConfigError, _>(
                &primary,
                || {
                    let (_, current) = read_signal_state(&user_dir);
                    let next = current
                        .max(self.revision.load(Ordering::SeqCst))
                        .saturating_add(1);
                    let rev_str = next.to_string();
                    let signal = SkillMutationSignal {
                        revision: rev_str.clone(),
                        pid: std::process::id(),
                        at: Utc::now().to_rfc3339(),
                    };
                    let serialized = format!(
                        "{}\n",
                        serde_json::to_string_pretty(&signal).unwrap_or_else(|_| "{}".to_owned())
                    );
                    write_text_file_atomic(&primary, &serialized, Some(0o600))?;
                    harden_private_file_sync(&primary);
                    write_text_file_atomic(&mirror, &serialized, Some(0o600))?;
                    harden_private_file_sync(&mirror);
                    Ok((next, rev_str))
                },
                FileLockOptions {
                    lock_root: Some(lock_root),
                    ..Default::default()
                },
            )
            .map_err(|e| format!("failed writing shared-skill-mutation.json: {e}"))?;

        *self.last_token.lock() = Some(next_tok);
        self.revision.fetch_max(next_rev, Ordering::SeqCst);
        (self.callback)(next_rev);
        Ok(next_rev)
    }

    pub fn current_revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        *self.watcher.lock() = None;
    }
}

fn read_signal_state(user_cowork_dir: &Path) -> (Option<String>, u64) {
    for candidate in [
        user_cowork_dir.join("shared-skill-mutation.json"),
        user_cowork_dir.join("locks/shared-skill-mutation.json"),
    ] {
        if let Ok(raw) = fs::read_to_string(candidate)
            && let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw)
        {
            if let Some(s) = val.get("revision").and_then(serde_json::Value::as_str) {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    let num = trimmed.parse::<u64>().unwrap_or(1);
                    return (Some(trimmed.to_owned()), num);
                }
            } else if let Some(n) = val.get("revision").and_then(serde_json::Value::as_u64) {
                return (Some(n.to_string()), n);
            }
        }
    }
    (None, 0)
}
