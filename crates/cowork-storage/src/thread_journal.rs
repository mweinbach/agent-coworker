use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Notify, oneshot};

use crate::error::Result;
use crate::session_db::SessionDb;
use crate::types::{
    PersistedThreadJournalEvent, PersistedThreadJournalFailure, ThreadJournalEventInput,
};
use crate::write_coordinator::now_iso_millis;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadJournalHealth {
    pub trusted: bool,
    pub snapshot_required: bool,
    pub failed_write_count: u64,
    pub dropped_event_count: u64,
    pub pending_event_count: usize,
    pub pending_thread_count: usize,
    pub last_failure_at: Option<String>,
    pub last_failure_message: Option<String>,
    pub tail_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadJournalAggregateHealth {
    pub healthy: bool,
    pub backlog: usize,
    pub untrusted_thread_count: usize,
    pub failed_write_count: u64,
    pub dropped_event_count: u64,
    pub pending_thread_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadJournalReplayOutcome {
    pub health: ThreadJournalHealth,
    pub events: Vec<PersistedThreadJournalEvent>,
    pub fallback_snapshot: Option<Value>,
}

#[derive(Debug, Clone)]
struct FailureState {
    failed_write_count: u64,
    dropped_event_count: u64,
    last_failure_at: String,
    last_failure_message: String,
}

struct PendingItem {
    event: ThreadJournalEventInput,
    done: oneshot::Sender<Result<()>>,
}

struct ThreadQueue {
    pending: Vec<PendingItem>,
    in_flight_count: usize,
    idle_notify: Arc<Notify>,
}

/// Asynchronous monotonic per-thread event journal compatible with `src/server/runtime/ThreadJournal.ts`.
///
/// Batches queued writes per `thread_id` in strict arrival order, assigns monotonic `seq` values
/// (`1, 2, ...`), and provides `replay_or_fallback` which verifies sequence contiguity and JSON
/// integrity, recording `thread_journal_failures` and returning the full `session_snapshots`
/// fallback whenever a gap, `after_seq > tail_seq`, or parse error is encountered.
pub struct ThreadJournal {
    inner: Arc<ThreadJournalInner>,
}

struct ThreadJournalInner {
    session_db: Arc<SessionDb>,
    queues: Mutex<HashMap<String, ThreadQueue>>,
    failures: Mutex<HashMap<String, FailureState>>,
    closed: AtomicBool,
    /// Test-only pause point in `wait_for_idle` after the queue lock is released and before the
    /// idle notification is awaited, used to force the release/flush interleaving.
    #[cfg(test)]
    wait_gate: Mutex<Option<WaitGate>>,
}

#[cfg(test)]
struct WaitGate {
    reached: oneshot::Sender<()>,
    resume: oneshot::Receiver<()>,
}

impl ThreadJournal {
    pub fn new(session_db: Arc<SessionDb>) -> Self {
        Self {
            inner: Arc::new(ThreadJournalInner {
                session_db,
                queues: Mutex::new(HashMap::new()),
                failures: Mutex::new(HashMap::new()),
                closed: AtomicBool::new(false),
                #[cfg(test)]
                wait_gate: Mutex::new(None),
            }),
        }
    }

    pub async fn enqueue(&self, event: ThreadJournalEventInput) -> Result<()> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Ok(());
        }

        let (tx, rx) = oneshot::channel();
        let thread_id = event.thread_id.clone();
        let mut should_spawn_worker = false;

        {
            let mut queues = self.inner.queues.lock();
            if let Some(existing) = queues.get_mut(&thread_id) {
                existing.pending.push(PendingItem { event, done: tx });
            } else {
                queues.insert(
                    thread_id.clone(),
                    ThreadQueue {
                        pending: vec![PendingItem { event, done: tx }],
                        in_flight_count: 0,
                        idle_notify: Arc::new(Notify::new()),
                    },
                );
                should_spawn_worker = true;
            }
        }

        if should_spawn_worker {
            let inner = Arc::clone(&self.inner);
            tokio::spawn(async move {
                flush_thread_queue(inner, thread_id).await;
            });
        }

        match rx.await {
            Ok(res) => res,
            Err(_) => Ok(()),
        }
    }

    pub async fn wait_for_idle(&self, thread_id: &str) {
        loop {
            let notify: Arc<Notify>;
            let mut notified = std::pin::pin!(None);
            {
                let queues = self.inner.queues.lock();
                let Some(q) = queues.get(thread_id) else {
                    return;
                };
                if q.pending.is_empty() && q.in_flight_count == 0 {
                    return;
                }
                // Register for the idle notification while still holding the queue lock: the
                // worker removes the drained queue and calls `notify_waiters()` under this same
                // lock, and that call only wakes `Notified` futures that already exist. Creating
                // and enabling the future here means a flush that completes right after the lock
                // is released can no longer be missed.
                notify = Arc::clone(&q.idle_notify);
                notified.set(Some(notify.notified()));
                if let Some(registered) = notified.as_mut().as_pin_mut() {
                    registered.enable();
                }
            }
            #[cfg(test)]
            self.pause_at_wait_gate().await;
            if let Some(registered) = notified.as_pin_mut() {
                registered.await;
            }
            // Loop to re-check: the queue may have been removed (idle) or refilled by new events,
            // possibly under a fresh queue with a different notifier.
        }
    }

    #[cfg(test)]
    async fn pause_at_wait_gate(&self) {
        let gate = self.inner.wait_gate.lock().take();
        if let Some(gate) = gate {
            let _ = gate.reached.send(());
            let _ = gate.resume.await;
        }
    }

    pub async fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        loop {
            let active_threads: Vec<String> = {
                let queues = self.inner.queues.lock();
                queues.keys().cloned().collect()
            };
            if active_threads.is_empty() {
                break;
            }
            for tid in active_threads {
                self.wait_for_idle(&tid).await;
            }
        }
    }

    pub fn list(
        &self,
        thread_id: &str,
        after_seq: u64,
        limit: Option<usize>,
    ) -> Result<Vec<PersistedThreadJournalEvent>> {
        self.inner
            .session_db
            .list_thread_journal_events(thread_id, after_seq, limit)
    }

    /// Persisted events of one `event_type` for a thread, oldest first.
    pub fn list_by_type(
        &self,
        thread_id: &str,
        event_type: &str,
    ) -> Result<Vec<PersistedThreadJournalEvent>> {
        self.inner
            .session_db
            .list_thread_journal_events_by_type(thread_id, event_type)
    }

    /// The oldest persisted `event_type` event whose payload has `payload_key == value`.
    pub fn find_by_payload_string(
        &self,
        thread_id: &str,
        event_type: &str,
        payload_key: &str,
        value: &str,
    ) -> Result<Option<PersistedThreadJournalEvent>> {
        self.inner
            .session_db
            .find_thread_journal_event_by_payload_string(thread_id, event_type, payload_key, value)
    }

    pub fn get_health(&self, thread_id: &str) -> Result<ThreadJournalHealth> {
        let failure = self.load_or_cache_failure(thread_id)?;
        let (pending_event_count, pending_thread_count) = {
            let queues = self.inner.queues.lock();
            let count = queues
                .get(thread_id)
                .map(|q| q.pending.len() + q.in_flight_count)
                .unwrap_or(0);
            (count, queues.len())
        };
        let tail_seq = self
            .inner
            .session_db
            .get_thread_journal_tail_seq(thread_id)?;
        let trusted = failure.is_none();

        Ok(ThreadJournalHealth {
            trusted,
            snapshot_required: !trusted,
            failed_write_count: failure.as_ref().map(|f| f.failed_write_count).unwrap_or(0),
            dropped_event_count: failure.as_ref().map(|f| f.dropped_event_count).unwrap_or(0),
            pending_event_count,
            pending_thread_count,
            last_failure_at: failure.as_ref().map(|f| f.last_failure_at.clone()),
            last_failure_message: failure.as_ref().map(|f| f.last_failure_message.clone()),
            tail_seq,
        })
    }

    pub fn get_aggregate_health(&self) -> ThreadJournalAggregateHealth {
        let mut combined: HashMap<String, (u64, u64)> = HashMap::new();
        if let Ok(persisted) = self.inner.session_db.list_thread_journal_failures() {
            for p in persisted {
                combined.insert(p.thread_id, (p.failed_write_count, p.dropped_event_count));
            }
        }
        {
            let failures = self.inner.failures.lock();
            for (tid, f) in failures.iter() {
                combined.insert(tid.clone(), (f.failed_write_count, f.dropped_event_count));
            }
        }
        let untrusted_thread_count = combined.len();
        let mut failed_write_count = 0_u64;
        let mut dropped_event_count = 0_u64;
        for (fw, de) in combined.values() {
            failed_write_count += *fw;
            dropped_event_count += *de;
        }

        let (backlog, pending_thread_count) = {
            let queues = self.inner.queues.lock();
            let mut total = 0_usize;
            let mut threads = 0_usize;
            for q in queues.values() {
                let n = q.pending.len() + q.in_flight_count;
                if n > 0 {
                    threads += 1;
                    total += n;
                }
            }
            (total, threads)
        };

        ThreadJournalAggregateHealth {
            healthy: untrusted_thread_count == 0
                && failed_write_count == 0
                && dropped_event_count == 0,
            backlog,
            untrusted_thread_count,
            failed_write_count,
            dropped_event_count,
            pending_thread_count,
        }
    }

    /// Replays journal events strictly after `after_seq`, or records a journal failure and
    /// returns the authoritative full snapshot when untrusted, out-of-range, gapped, or corrupt.
    pub async fn replay_or_fallback(
        &self,
        thread_id: &str,
        after_seq: u64,
    ) -> Result<ThreadJournalReplayOutcome> {
        self.wait_for_idle(thread_id).await;

        let initial_health = self.get_health(thread_id)?;
        if !initial_health.trusted {
            let fallback = self.load_fallback_snapshot(thread_id)?;
            return Ok(ThreadJournalReplayOutcome {
                health: initial_health,
                events: Vec::new(),
                fallback_snapshot: fallback,
            });
        }

        if after_seq > initial_health.tail_seq {
            record_failure(
                &self.inner,
                thread_id,
                0,
                &format!(
                    "Requested afterSeq {} exceeds journal tailSeq {}",
                    after_seq, initial_health.tail_seq
                ),
            )
            .await;
            let health = self.get_health(thread_id)?;
            let fallback = self.load_fallback_snapshot(thread_id)?;
            return Ok(ThreadJournalReplayOutcome {
                health,
                events: Vec::new(),
                fallback_snapshot: fallback,
            });
        }

        let events = match self
            .inner
            .session_db
            .list_thread_journal_events(thread_id, after_seq, None)
        {
            Ok(evts) => evts,
            Err(err) => {
                record_failure(
                    &self.inner,
                    thread_id,
                    0,
                    &format!("Journal replay read/parse error: {err}"),
                )
                .await;
                let health = self.get_health(thread_id)?;
                let fallback = self.load_fallback_snapshot(thread_id)?;
                return Ok(ThreadJournalReplayOutcome {
                    health,
                    events: Vec::new(),
                    fallback_snapshot: fallback,
                });
            }
        };

        // Verify strictly contiguous sequence `after_seq + 1 ..= tail_seq`.
        let mut expected_seq = after_seq + 1;
        let mut gap_message: Option<String> = None;
        for ev in &events {
            if ev.seq != expected_seq {
                gap_message = Some(format!(
                    "Detected journal sequence gap on thread {thread_id}: expected seq {expected_seq}, got {}",
                    ev.seq
                ));
                break;
            }
            expected_seq += 1;
        }
        if gap_message.is_none() && expected_seq - 1 != initial_health.tail_seq {
            gap_message = Some(format!(
                "Journal tail mismatch on thread {thread_id}: expected final seq {}, got {}",
                initial_health.tail_seq,
                expected_seq - 1
            ));
        }

        if let Some(reason) = gap_message {
            record_failure(&self.inner, thread_id, 1, &reason).await;
            let health = self.get_health(thread_id)?;
            let fallback = self.load_fallback_snapshot(thread_id)?;
            return Ok(ThreadJournalReplayOutcome {
                health,
                events: Vec::new(),
                fallback_snapshot: fallback,
            });
        }

        Ok(ThreadJournalReplayOutcome {
            health: initial_health,
            events,
            fallback_snapshot: None,
        })
    }

    fn load_fallback_snapshot(&self, thread_id: &str) -> Result<Option<Value>> {
        if let Some(snap) = self.inner.session_db.get_session_snapshot(thread_id)? {
            return Ok(Some(snap));
        }
        self.inner.session_db.project_legacy_snapshot(thread_id)
    }

    fn load_or_cache_failure(&self, thread_id: &str) -> Result<Option<FailureState>> {
        if let Some(mem) = self.inner.failures.lock().get(thread_id).cloned() {
            return Ok(Some(mem));
        }
        if let Some(persisted) = self
            .inner
            .session_db
            .get_thread_journal_failure(thread_id)?
        {
            let state = FailureState {
                failed_write_count: persisted.failed_write_count,
                dropped_event_count: persisted.dropped_event_count,
                last_failure_at: persisted.last_failure_at,
                last_failure_message: persisted.last_failure_message,
            };
            self.inner
                .failures
                .lock()
                .insert(thread_id.to_string(), state.clone());
            return Ok(Some(state));
        }
        Ok(None)
    }
}

async fn flush_thread_queue(inner: Arc<ThreadJournalInner>, thread_id: String) {
    loop {
        let (mut batch, notify) = {
            let mut queues = inner.queues.lock();
            let Some(q) = queues.get_mut(&thread_id) else {
                return;
            };
            if q.pending.is_empty() {
                let notify = Arc::clone(&q.idle_notify);
                queues.remove(&thread_id);
                notify.notify_waiters();
                return;
            }
            let taken = std::mem::take(&mut q.pending);
            q.in_flight_count = taken.len();
            (taken, Arc::clone(&q.idle_notify))
        };

        let inputs: Vec<ThreadJournalEventInput> =
            batch.iter().map(|item| item.event.clone()).collect();
        let append_res = inner.session_db.append_thread_journal_events(&inputs).await;

        match append_res {
            Ok(_) => {
                for item in batch {
                    let _ = item.done.send(Ok(()));
                }
            }
            Err(err) => {
                if inner.closed.load(Ordering::SeqCst) {
                    let mut queues = inner.queues.lock();
                    if let Some(q) = queues.get_mut(&thread_id) {
                        batch.extend(std::mem::take(&mut q.pending));
                    }
                }
                let err_msg = err.to_string();
                record_failure(&inner, &thread_id, batch.len() as u64, &err_msg).await;
                for item in batch {
                    let _ = item
                        .done
                        .send(Err(crate::error::StorageError::Conflict(err_msg.clone())));
                }
            }
        }

        {
            let mut queues = inner.queues.lock();
            if let Some(q) = queues.get_mut(&thread_id) {
                q.in_flight_count = 0;
                if q.pending.is_empty() {
                    queues.remove(&thread_id);
                    notify.notify_waiters();
                    return;
                }
            } else {
                notify.notify_waiters();
                return;
            }
        }
    }
}

async fn record_failure(
    inner: &ThreadJournalInner,
    thread_id: &str,
    dropped_count: u64,
    message: &str,
) {
    let previous = {
        let mem = inner.failures.lock().get(thread_id).cloned();
        match mem {
            Some(m) => Some(m),
            None => inner
                .session_db
                .get_thread_journal_failure(thread_id)
                .ok()
                .flatten()
                .map(|p| FailureState {
                    failed_write_count: p.failed_write_count,
                    dropped_event_count: p.dropped_event_count,
                    last_failure_at: p.last_failure_at,
                    last_failure_message: p.last_failure_message,
                }),
        }
    };

    let next = FailureState {
        failed_write_count: previous.as_ref().map(|p| p.failed_write_count).unwrap_or(0) + 1,
        dropped_event_count: previous
            .as_ref()
            .map(|p| p.dropped_event_count)
            .unwrap_or(0)
            + dropped_count,
        last_failure_at: now_iso_millis(),
        last_failure_message: message.to_string(),
    };

    inner
        .failures
        .lock()
        .insert(thread_id.to_string(), next.clone());

    let persisted = PersistedThreadJournalFailure {
        thread_id: thread_id.to_string(),
        failed_write_count: next.failed_write_count,
        dropped_event_count: next.dropped_event_count,
        last_failure_at: next.last_failure_at,
        last_failure_message: next.last_failure_message,
    };
    let _ = inner
        .session_db
        .record_thread_journal_failure(&persisted)
        .await;
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::types::SessionDbOptions;

    struct TempRoot(PathBuf);

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn open_journal(prefix: &str) -> (TempRoot, Arc<SessionDb>, ThreadJournal) {
        let root = std::env::temp_dir().join(format!(
            "cowork-thread-journal-{prefix}-{}",
            uuid::Uuid::new_v4()
        ));
        let sessions_dir = root.join("sessions");
        std::fs::create_dir_all(&sessions_dir).expect("create temp sessions dir");
        let db = Arc::new(
            SessionDb::open(SessionDbOptions {
                root_dir: root.clone(),
                sessions_dir,
                db_path: None,
                busy_timeout_ms: Some(5_000),
            })
            .await
            .expect("open session db"),
        );
        let journal = ThreadJournal::new(Arc::clone(&db));
        (TempRoot(root), db, journal)
    }

    fn journal_event(thread_id: &str, idx: usize) -> ThreadJournalEventInput {
        ThreadJournalEventInput {
            thread_id: thread_id.to_string(),
            ts: "2026-04-17T12:00:00.000Z".to_string(),
            event_type: "item/agentMessage/delta".to_string(),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("msg-1".to_string()),
            request_id: None,
            payload: json!({ "delta": format!("chunk-{idx}") }),
        }
    }

    /// Arms the test gate and returns (reached, resume) handles for the paused waiter.
    fn arm_wait_gate(journal: &ThreadJournal) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (reached_tx, reached_rx) = oneshot::channel();
        let (resume_tx, resume_rx) = oneshot::channel();
        *journal.inner.wait_gate.lock() = Some(WaitGate {
            reached: reached_tx,
            resume: resume_rx,
        });
        (reached_rx, resume_tx)
    }

    /// The worker drains the queue (removing it and calling `notify_waiters`) after
    /// `wait_for_idle` released the queue lock but before it awaited the notification.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_for_idle_observes_idle_notification_sent_after_lock_release() {
        let (_root, db, journal) = open_journal("drain-race").await;
        let journal = Arc::new(journal);
        let (done_tx, done_rx) = oneshot::channel();
        journal.inner.queues.lock().insert(
            "thread-race".to_string(),
            ThreadQueue {
                pending: vec![PendingItem {
                    event: journal_event("thread-race", 1),
                    done: done_tx,
                }],
                in_flight_count: 0,
                idle_notify: Arc::new(Notify::new()),
            },
        );
        let (reached, resume) = arm_wait_gate(&journal);

        let waiter = tokio::spawn({
            let journal = Arc::clone(&journal);
            async move { journal.wait_for_idle("thread-race").await }
        });
        tokio::time::timeout(Duration::from_secs(5), reached)
            .await
            .expect("waiter reached the gate")
            .expect("gate sender alive");

        // Worker appends the batch, then removes the drained queue and calls `notify_waiters`.
        flush_thread_queue(Arc::clone(&journal.inner), "thread-race".to_string()).await;
        assert!(done_rx.await.expect("batch completed").is_ok());
        assert!(journal.inner.queues.lock().get("thread-race").is_none());
        assert_eq!(db.get_thread_journal_tail_seq("thread-race").unwrap(), 1);

        // A later event creates a fresh queue with a different notifier.
        let (later_tx, _later_rx) = oneshot::channel();
        journal.inner.queues.lock().insert(
            "thread-race".to_string(),
            ThreadQueue {
                pending: vec![PendingItem {
                    event: journal_event("thread-race", 2),
                    done: later_tx,
                }],
                in_flight_count: 0,
                idle_notify: Arc::new(Notify::new()),
            },
        );

        resume.send(()).expect("waiter still paused at gate");
        // The later queue drains too; a waiter stuck on the first queue's notifier would never
        // be woken by it.
        flush_thread_queue(Arc::clone(&journal.inner), "thread-race".to_string()).await;
        assert!(journal.inner.queues.lock().get("thread-race").is_none());
        assert_eq!(db.get_thread_journal_tail_seq("thread-race").unwrap(), 2);
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("wait_for_idle must not hang after a missed idle notification")
            .expect("waiter task panicked");
    }

    /// Same interleaving through the empty-queue exit of the worker loop.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn wait_for_idle_observes_empty_queue_removal_after_lock_release() {
        let (_root, _db, journal) = open_journal("empty-race").await;
        let journal = Arc::new(journal);
        journal.inner.queues.lock().insert(
            "thread-empty".to_string(),
            ThreadQueue {
                pending: Vec::new(),
                in_flight_count: 1,
                idle_notify: Arc::new(Notify::new()),
            },
        );
        let (reached, resume) = arm_wait_gate(&journal);

        let waiter = tokio::spawn({
            let journal = Arc::clone(&journal);
            async move { journal.wait_for_idle("thread-empty").await }
        });
        tokio::time::timeout(Duration::from_secs(5), reached)
            .await
            .expect("waiter reached the gate")
            .expect("gate sender alive");

        journal
            .inner
            .queues
            .lock()
            .get_mut("thread-empty")
            .expect("queue present")
            .in_flight_count = 0;
        flush_thread_queue(Arc::clone(&journal.inner), "thread-empty".to_string()).await;
        assert!(journal.inner.queues.lock().get("thread-empty").is_none());

        resume.send(()).expect("waiter still paused at gate");
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("wait_for_idle must not hang after a missed idle notification")
            .expect("waiter task panicked");
    }

    /// Many concurrent waiters racing real enqueue/flush cycles on a multi-thread runtime.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_wait_for_idle_and_enqueue_never_hang() {
        let (_root, db, journal) = open_journal("stress").await;
        let journal = Arc::new(journal);
        let rounds = 200_usize;
        let mut tasks = Vec::new();
        for writer in 0..4_usize {
            let journal = Arc::clone(&journal);
            tasks.push(tokio::spawn(async move {
                for idx in 0..rounds {
                    journal
                        .enqueue(journal_event("thread-stress", writer * rounds + idx))
                        .await
                        .expect("enqueue");
                    tokio::task::yield_now().await;
                }
            }));
        }
        for _ in 0..8 {
            let journal = Arc::clone(&journal);
            tasks.push(tokio::spawn(async move {
                for _ in 0..rounds {
                    journal.wait_for_idle("thread-stress").await;
                    tokio::task::yield_now().await;
                }
            }));
        }
        tokio::time::timeout(Duration::from_secs(60), async {
            for task in tasks {
                task.await.expect("task panicked");
            }
            journal.close().await;
        })
        .await
        .expect("wait_for_idle/close hung under concurrent enqueue/flush");
        assert_eq!(
            db.get_thread_journal_tail_seq("thread-stress").unwrap(),
            (4 * rounds) as u64
        );
    }
}
