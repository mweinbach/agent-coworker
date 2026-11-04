use std::collections::{HashMap, HashSet, VecDeque};

use cowork_protocol::is_evictable_stream_delta;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::MAX_OUTBOUND_QUEUE_CAPACITY;

/// Result of attempting an immediate non-blocking write to a transport sink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendSinkOutcome {
    /// Frame was accepted by the underlying socket buffer.
    Accepted,
    /// Socket is currently backpressured; frame was NOT written and must remain queued.
    Backpressured,
    /// Socketaccepted this frame, AND signaled that subsequent frames should pause until drain.
    AcceptedThenBackpressured,
    /// Underlying socket is closed; drop connection queue.
    Closed,
}

#[derive(Debug, Clone)]
struct QueuedFrame {
    serialized: String,
    is_delta: bool,
}

#[derive(Debug, Default)]
struct ConnectionQueueState {
    queue: VecDeque<QueuedFrame>,
    paused_for_drain: bool,
    opt_out_methods: HashSet<String>,
    tool_retry_lineage: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendQueueStats {
    pub queued_sends: u64,
    pub dropped_deltas: u64,
    pub dropped_important: u64,
    pub serialization_failures: u64,
    pub send_failures: u64,
    pub external_sink_failures: u64,
    pub max_queue_depth: usize,
    pub queue_depth_by_connection: HashMap<String, usize>,
}

#[derive(Debug)]
struct InnerQueue {
    max_capacity: usize,
    queued_sends: u64,
    dropped_deltas: u64,
    dropped_important: u64,
    serialization_failures: u64,
    send_failures: u64,
    external_sink_failures: u64,
    max_queue_depth: usize,
    connections: HashMap<String, ConnectionQueueState>,
}

/// Bounded per-connection outbound queue (`500` cap) that evicts only streaming deltas under backpressure.
#[derive(Debug)]
pub struct SocketSendQueue {
    inner: Mutex<InnerQueue>,
}

impl Default for SocketSendQueue {
    fn default() -> Self {
        Self::new(MAX_OUTBOUND_QUEUE_CAPACITY)
    }
}

impl SocketSendQueue {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            inner: Mutex::new(InnerQueue {
                max_capacity: max_capacity.max(1),
                queued_sends: 0,
                dropped_deltas: 0,
                dropped_important: 0,
                serialization_failures: 0,
                send_failures: 0,
                external_sink_failures: 0,
                max_queue_depth: 0,
                connections: HashMap::new(),
            }),
        }
    }

    pub fn set_connection_capabilities(
        &self,
        connection_id: &str,
        opt_out_methods: HashSet<String>,
        tool_retry_lineage: bool,
    ) {
        let mut guard = self.inner.lock();
        let state = guard
            .connections
            .entry(connection_id.to_owned())
            .or_default();
        state.opt_out_methods = opt_out_methods;
        state.tool_retry_lineage = tool_retry_lineage;
    }

    pub fn remove_connection(&self, connection_id: &str) {
        self.inner.lock().connections.remove(connection_id);
    }

    pub fn should_send_notification(&self, connection_id: &str, method: &str) -> bool {
        let guard = self.inner.lock();
        guard
            .connections
            .get(connection_id)
            .is_none_or(|state| !state.opt_out_methods.contains(method))
    }

    pub fn tool_retry_lineage_enabled(&self, connection_id: &str) -> bool {
        self.inner
            .lock()
            .connections
            .get(connection_id)
            .is_some_and(|s| s.tool_retry_lineage)
    }

    /// Sends or queues a JSON-RPC-lite payload, enforcing FIFO ordering and delta-only eviction up to capacity.
    pub fn send<F>(&self, connection_id: &str, payload: &Value, mut try_write: F)
    where
        F: FnMut(&str) -> SendSinkOutcome,
    {
        let mut guard = self.inner.lock();
        let max_capacity = guard.max_capacity;

        // Check notification opt-out & toolRetryLineage projection
        let (opted_out, retry_lineage) = guard
            .connections
            .get(connection_id)
            .map(|s| {
                let opted_out = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .is_some_and(|m| payload.get("id").is_none() && s.opt_out_methods.contains(m));
                (opted_out, s.tool_retry_lineage)
            })
            .unwrap_or((false, false));

        if opted_out {
            return;
        }

        let Some(effective_payload) =
            cowork_protocol::project_tool_retry_compatibility(retry_lineage, payload)
        else {
            return;
        };

        let is_delta = is_evictable_stream_delta(&effective_payload);
        let Ok(serialized) = serde_json::to_string(&effective_payload) else {
            guard.serialization_failures += 1;
            return;
        };

        let has_backlog = guard
            .connections
            .get(connection_id)
            .is_some_and(|s| s.paused_for_drain || !s.queue.is_empty());

        if !has_backlog {
            match try_write(&serialized) {
                SendSinkOutcome::Accepted => return,
                SendSinkOutcome::AcceptedThenBackpressured => {
                    guard
                        .connections
                        .entry(connection_id.to_owned())
                        .or_default()
                        .paused_for_drain = true;
                    return;
                }
                SendSinkOutcome::Closed => {
                    guard.connections.remove(connection_id);
                    return;
                }
                SendSinkOutcome::Backpressured => {}
            }
        }

        let mut dropped_deltas_inc = 0u64;
        let mut dropped_important_inc = 0u64;
        let mut queued_inc = 0u64;
        let new_depth;

        {
            let state = guard
                .connections
                .entry(connection_id.to_owned())
                .or_default();
            state.paused_for_drain = true;

            if state.queue.len() >= max_capacity {
                if let Some(oldest_delta_idx) = state.queue.iter().position(|item| item.is_delta) {
                    state.queue.remove(oldest_delta_idx);
                    dropped_deltas_inc += 1;
                } else if is_delta {
                    // Queue is full of non-delta important items: drop the incoming delta!
                    dropped_deltas_inc += 1;
                    guard.dropped_deltas += dropped_deltas_inc;
                    return;
                } else {
                    // Queue is full of important items and incoming is also important: drop oldest
                    state.queue.pop_front();
                    dropped_important_inc += 1;
                }
            }

            state.queue.push_back(QueuedFrame {
                serialized,
                is_delta,
            });
            new_depth = state.queue.len();
            queued_inc += 1;
        }

        guard.dropped_deltas += dropped_deltas_inc;
        guard.dropped_important += dropped_important_inc;
        guard.queued_sends += queued_inc;
        if new_depth > guard.max_queue_depth {
            guard.max_queue_depth = new_depth;
        }
    }

    /// Flushes queued frames in FIFO order until empty or backpressured again.
    pub fn flush<F>(&self, connection_id: &str, mut try_write: F)
    where
        F: FnMut(&str) -> SendSinkOutcome,
    {
        let mut guard = self.inner.lock();
        let Some(state) = guard.connections.get_mut(connection_id) else {
            return;
        };

        state.paused_for_drain = false;
        while let Some(front) = state.queue.front() {
            match try_write(&front.serialized) {
                SendSinkOutcome::Accepted => {
                    state.queue.pop_front();
                }
                SendSinkOutcome::AcceptedThenBackpressured => {
                    state.queue.pop_front();
                    state.paused_for_drain = true;
                    break;
                }
                SendSinkOutcome::Backpressured => {
                    state.paused_for_drain = true;
                    break;
                }
                SendSinkOutcome::Closed => {
                    guard.connections.remove(connection_id);
                    return;
                }
            }
        }
    }

    pub fn stats(&self) -> SendQueueStats {
        let guard = self.inner.lock();
        let mut depth = HashMap::new();
        for (conn_id, state) in &guard.connections {
            if !state.queue.is_empty() {
                depth.insert(conn_id.clone(), state.queue.len());
            }
        }
        SendQueueStats {
            queued_sends: guard.queued_sends,
            dropped_deltas: guard.dropped_deltas,
            dropped_important: guard.dropped_important,
            serialization_failures: guard.serialization_failures,
            send_failures: guard.send_failures,
            external_sink_failures: guard.external_sink_failures,
            max_queue_depth: guard.max_queue_depth,
            queue_depth_by_connection: depth,
        }
    }
}
