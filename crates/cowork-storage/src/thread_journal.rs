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
}

impl ThreadJournal {
    pub fn new(session_db: Arc<SessionDb>) -> Self {
        Self {
            inner: Arc::new(ThreadJournalInner {
                session_db,
                queues: Mutex::new(HashMap::new()),
                failures: Mutex::new(HashMap::new()),
                closed: AtomicBool::new(false),
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
            let notify = {
                let queues = self.inner.queues.lock();
                let Some(q) = queues.get(thread_id) else {
                    return;
                };
                if q.pending.is_empty() && q.in_flight_count == 0 {
                    return;
                }
                Arc::clone(&q.idle_notify)
            };
            notify.notified().await;
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
        let (failed_write_count, dropped_event_count) = {
            let failures = self.inner.failures.lock();
            let mut fw = 0_u64;
            let mut de = 0_u64;
            for f in failures.values() {
                fw += f.failed_write_count;
                de += f.dropped_event_count;
            }
            (fw, de)
        };

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
            healthy: failed_write_count == 0 && dropped_event_count == 0,
            backlog,
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
