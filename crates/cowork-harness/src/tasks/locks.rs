//! Session and task lock registry (`active_source_chat` and `terminal_task_thread`).
//!
//! Mirrors `src/server/session/taskLocks.ts`.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

use cowork_storage::{SessionDb, TaskRecord, TaskStatus};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskLockKind {
    ActiveSourceChat,
    TerminalTaskThread,
}

impl TaskLockKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ActiveSourceChat => "active_source_chat",
            Self::TerminalTaskThread => "terminal_task_thread",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLockErrorData {
    pub category: String,
    pub source: String,
    pub lock_kind: TaskLockKind,
    pub task_id: String,
    pub task_status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_title: Option<String>,
}

impl TaskLockErrorData {
    pub fn to_json_value(&self) -> Value {
        let mut obj = json!({
            "category": self.category,
            "source": self.source,
            "lockKind": self.lock_kind.as_str(),
            "taskId": self.task_id,
            "taskStatus": self.task_status.as_str(),
        });
        if let Some(ref title) = self.task_title
            && let Some(map) = obj.as_object_mut()
        {
            map.insert("taskTitle".to_owned(), Value::String(title.clone()));
        }
        obj
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskLockError {
    pub message: String,
    pub data: TaskLockErrorData,
}

pub fn is_terminal_task_status(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed | TaskStatus::Cancelled | TaskStatus::Failed
    )
}

#[derive(Default)]
struct LockRegistry {
    pending_terminal_session_locks: BTreeMap<String, (u64, TaskLockError)>,
    pending_terminal_task_locks: BTreeMap<String, (u64, TaskLockError)>,
    settling_terminal_session_locks: BTreeMap<String, Vec<(u64, TaskLockError)>>,
}

static LOCK_REGISTRY: OnceLock<Mutex<LockRegistry>> = OnceLock::new();
static NEXT_LOCK_TOKEN: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<LockRegistry> {
    LOCK_REGISTRY.get_or_init(|| Mutex::new(LockRegistry::default()))
}

fn terminal_task_lock(task_id: &str, status: TaskStatus) -> Option<TaskLockError> {
    if !is_terminal_task_status(status) {
        return None;
    }
    Some(TaskLockError {
        message: format!(
            "Task {task_id} is {} and cannot accept new turns until it is reopened or retried.",
            status.as_str()
        ),
        data: TaskLockErrorData {
            category: "task_locked".to_owned(),
            source: "session".to_owned(),
            lock_kind: TaskLockKind::TerminalTaskThread,
            task_id: task_id.to_owned(),
            task_status: status,
            task_title: None,
        },
    })
}

fn active_source_chat_lock(task_id: &str, status: TaskStatus, title: &str) -> TaskLockError {
    TaskLockError {
        message: format!("Chat is locked by active task {task_id}: {title}"),
        data: TaskLockErrorData {
            category: "task_locked".to_owned(),
            source: "session".to_owned(),
            lock_kind: TaskLockKind::ActiveSourceChat,
            task_id: task_id.to_owned(),
            task_status: status,
            task_title: Some(title.to_owned()),
        },
    }
}

fn pending_terminal_task_lock(task_id: &str, status: TaskStatus) -> TaskLockError {
    TaskLockError {
        message: format!(
            "Task {task_id} is finalizing {} and cannot be changed until terminal quiescence finishes.",
            status.as_str()
        ),
        data: TaskLockErrorData {
            category: "task_locked".to_owned(),
            source: "session".to_owned(),
            lock_kind: TaskLockKind::TerminalTaskThread,
            task_id: task_id.to_owned(),
            task_status: status,
            task_title: None,
        },
    }
}

fn pending_terminal_source_chat_lock(
    task_id: &str,
    title: &str,
    status: TaskStatus,
) -> TaskLockError {
    TaskLockError {
        message: format!(
            "Chat is locked while task {task_id} is finalizing {}: {title}",
            status.as_str()
        ),
        data: TaskLockErrorData {
            category: "task_locked".to_owned(),
            source: "session".to_owned(),
            lock_kind: TaskLockKind::ActiveSourceChat,
            task_id: task_id.to_owned(),
            task_status: status,
            task_title: Some(title.to_owned()),
        },
    }
}

pub struct PendingTerminalLockGuard {
    released: bool,
    token: u64,
    task_id: String,
    session_ids: Vec<String>,
}

impl PendingTerminalLockGuard {
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut reg = registry().lock();
        if reg
            .pending_terminal_task_locks
            .get(&self.task_id)
            .is_some_and(|(t, _)| *t == self.token)
        {
            reg.pending_terminal_task_locks.remove(&self.task_id);
        }
        for sid in &self.session_ids {
            if reg
                .pending_terminal_session_locks
                .get(sid)
                .is_some_and(|(t, _)| *t == self.token)
            {
                reg.pending_terminal_session_locks.remove(sid);
            }
        }
    }
}

impl Drop for PendingTerminalLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

pub fn register_pending_terminal_task_locks(
    task: &TaskRecord,
    status: TaskStatus,
) -> PendingTerminalLockGuard {
    let token = NEXT_LOCK_TOKEN.fetch_add(1, Ordering::Relaxed);
    let task_lock = pending_terminal_task_lock(&task.id, status);
    let mut reg = registry().lock();
    reg.pending_terminal_task_locks
        .insert(task.id.clone(), (token, task_lock.clone()));

    let mut session_ids = Vec::new();
    let task_session_set: BTreeSet<String> =
        task.threads.iter().map(|t| t.session_id.clone()).collect();
    for sid in &task_session_set {
        reg.pending_terminal_session_locks
            .insert(sid.clone(), (token, task_lock.clone()));
        session_ids.push(sid.clone());
    }
    if let Some(ref src_sid) = task.source_session_id
        && !task_session_set.contains(src_sid)
    {
        let src_lock = pending_terminal_source_chat_lock(&task.id, &task.title, status);
        reg.pending_terminal_session_locks
            .insert(src_sid.clone(), (token, src_lock));
        session_ids.push(src_sid.clone());
    }

    PendingTerminalLockGuard {
        released: false,
        token,
        task_id: task.id.clone(),
        session_ids,
    }
}

pub fn get_pending_terminal_task_lock(task_id: &str) -> Option<TaskLockError> {
    registry()
        .lock()
        .pending_terminal_task_locks
        .get(task_id)
        .map(|(_, l)| l.clone())
}

pub struct SettlingSessionLockGuard {
    released: bool,
    token: u64,
    session_id: String,
}

impl SettlingSessionLockGuard {
    pub fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let mut reg = registry().lock();
        if let Some(entries) = reg
            .settling_terminal_session_locks
            .get_mut(&self.session_id)
        {
            entries.retain(|(t, _)| *t != self.token);
            if entries.is_empty() {
                reg.settling_terminal_session_locks.remove(&self.session_id);
            }
        }
    }
}

impl Drop for SettlingSessionLockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

pub fn register_settling_terminal_session_lock(
    session_id: &str,
    lock: TaskLockError,
) -> SettlingSessionLockGuard {
    let token = NEXT_LOCK_TOKEN.fetch_add(1, Ordering::Relaxed);
    let mut reg = registry().lock();
    reg.settling_terminal_session_locks
        .entry(session_id.to_owned())
        .or_default()
        .push((token, lock));
    SettlingSessionLockGuard {
        released: false,
        token,
        session_id: session_id.to_owned(),
    }
}

fn get_task_thread_lock(session_db: Option<&SessionDb>, session_id: &str) -> Option<TaskLockError> {
    if let Some(db) = session_db
        && let Ok(Some(task)) = db.get_task_for_thread(session_id)
        && let Some(durable) = terminal_task_lock(&task.id, task.status)
    {
        return Some(durable);
    }
    let reg = registry().lock();
    if let Some((_, pending)) = reg.pending_terminal_session_locks.get(session_id) {
        return Some(pending.clone());
    }
    reg.settling_terminal_session_locks
        .get(session_id)
        .and_then(|v| v.last())
        .map(|(_, l)| l.clone())
}

fn get_active_source_chat_lock(
    session_db: Option<&SessionDb>,
    session_id: &str,
) -> Option<TaskLockError> {
    let db = session_db?;
    let active_task = db.get_active_task_for_source_session(session_id).ok()??;
    Some(active_source_chat_lock(
        &active_task.id,
        active_task.status,
        &active_task.title,
    ))
}

pub type LiveParentSessionLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

pub fn get_session_task_lock(
    session_db: Option<&SessionDb>,
    session_id: &str,
    get_live_parent_session_id: Option<LiveParentSessionLookup<'_>>,
) -> Option<TaskLockError> {
    let mut seen = BTreeSet::new();
    let mut cursor = session_id.to_owned();
    loop {
        if !seen.insert(cursor.clone()) {
            return None;
        }
        if let Some(lock) = get_task_thread_lock(session_db, &cursor)
            .or_else(|| get_active_source_chat_lock(session_db, &cursor))
        {
            return Some(lock);
        }
        let live_parent = get_live_parent_session_id.and_then(|f| f(&cursor));
        let parent = live_parent.or_else(|| {
            session_db
                .and_then(|db| db.get_session_record(&cursor).ok().flatten())
                .and_then(|rec| rec.parent_session_id)
        });
        match parent {
            Some(p) if !p.trim().is_empty() => cursor = p,
            _ => return None,
        }
    }
}
