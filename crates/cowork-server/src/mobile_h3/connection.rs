use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use cowork_protocol::{
    JsonRpcLiteClientMessage, JsonRpcLiteId, JsonRpcLiteOutbound, WEBSOCKET_SUBPROTOCOL,
};
use dashmap::DashMap;
use futures_util::Stream;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::jsonrpc::{ConnectionRpcState, dispatch_client_message};
use crate::registry::{ConnectionAccessFlags, ServerRuntimeState};

pub const HTTP_RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_SSE_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

pub struct H3DeviceConnection {
    pub conn_state: Arc<ConnectionRpcState>,
    runtime: Arc<ServerRuntimeState>,
    keepalive_interval: Duration,
    closed: AtomicBool,
    close_notify: Arc<Notify>,
    in_flight: Mutex<HashMap<JsonRpcLiteId, u64>>,
    next_waiter_token: AtomicU64,
    next_sink_id: AtomicU64,
    sinks: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Bytes>>>>,
    keepalive_task: Mutex<Option<JoinHandle<()>>>,
    forwarder_task: JoinHandle<()>,
}

impl H3DeviceConnection {
    pub fn new(runtime: Arc<ServerRuntimeState>, keepalive_interval: Duration) -> Arc<Self> {
        let connection_id = Uuid::new_v4().to_string();
        let conn_state = Arc::new(ConnectionRpcState::new_with_protocol_mode(
            connection_id.clone(),
            "h3",
            "h3",
            Some(WEBSOCKET_SUBPROTOCOL.to_owned()),
        ));
        conn_state.set_task_permissions(false, false);
        runtime.set_connection_access(
            &connection_id,
            ConnectionAccessFlags {
                workspace_control_events_allowed: false,
                task_read_allowed: false,
                task_mutation_allowed: false,
            },
        );

        let (tx, mut rx) = mpsc::channel::<String>(256);
        runtime.register_ws_sink(&connection_id, tx);

        let sinks: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Bytes>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let sinks_for_fwd = Arc::clone(&sinks);
        let rt_for_fwd = Arc::clone(&runtime);
        let cid_for_fwd = connection_id.clone();

        let forwarder_task = tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                let sse_chunk = Bytes::from(format!("data: {frame}\n\n"));
                {
                    let mut guard = sinks_for_fwd.lock();
                    guard.retain(|_, sink_tx| sink_tx.send(sse_chunk.clone()).is_ok());
                }
                rt_for_fwd.flush_connection_queue(&cid_for_fwd);
            }
        });

        Arc::new(Self {
            conn_state,
            runtime,
            keepalive_interval,
            closed: AtomicBool::new(false),
            close_notify: Arc::new(Notify::new()),
            in_flight: Mutex::new(HashMap::new()),
            next_waiter_token: AtomicU64::new(1),
            next_sink_id: AtomicU64::new(1),
            sinks,
            keepalive_task: Mutex::new(None),
            forwarder_task,
        })
    }

    fn send_sse_frame(&self, json_frame: &str) {
        let chunk = Bytes::from(format!("data: {json_frame}\n\n"));
        let mut guard = self.sinks.lock();
        guard.retain(|_, tx| tx.send(chunk.clone()).is_ok());
        if guard.is_empty()
            && let Some(t) = self.keepalive_task.lock().take()
        {
            t.abort();
        }
    }

    fn sync_keepalive(self: &Arc<Self>) {
        if self.sinks.lock().is_empty() {
            if let Some(t) = self.keepalive_task.lock().take() {
                t.abort();
            }
            return;
        }
        let mut kt = self.keepalive_task.lock();
        if kt.is_some() {
            return;
        }
        let interval_dur = self.keepalive_interval;
        let sinks_ref = Arc::clone(&self.sinks);
        let close_ref = Arc::clone(&self.close_notify);
        *kt = Some(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval_dur);
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = close_ref.notified() => break,
                    _ = ticker.tick() => {
                        let chunk = Bytes::from_static(b": keepalive\n\n");
                        let mut guard = sinks_ref.lock();
                        guard.retain(|_, tx| tx.send(chunk.clone()).is_ok());
                        if guard.is_empty() {
                            break;
                        }
                    }
                }
            }
        }));
    }

    pub fn add_event_sink(self: &Arc<Self>) -> (u64, mpsc::UnboundedReceiver<Bytes>) {
        let sink_id = self.next_sink_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let _ = tx.send(Bytes::from_static(b": cowork events\n\n"));
        self.sinks.lock().insert(sink_id, tx);
        self.sync_keepalive();
        (sink_id, rx)
    }

    pub fn remove_event_sink(self: &Arc<Self>, sink_id: u64) {
        self.sinks.lock().remove(&sink_id);
        self.sync_keepalive();
    }

    pub async fn dispatch(
        self: &Arc<Self>,
        message: JsonRpcLiteClientMessage,
    ) -> Result<Option<Value>, String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("HTTP JSON-RPC connection closed.".to_owned());
        }

        match message {
            JsonRpcLiteClientMessage::Notification(_)
            | JsonRpcLiteClientMessage::ClientResponse(_) => {
                if let Some(resp) =
                    dispatch_client_message(&self.runtime, &self.conn_state, message).await
                    && let Ok(serialized) = serde_json::to_string(&resp)
                {
                    self.send_sse_frame(&serialized);
                }
                for notif in self.conn_state.drain_deferred_broadcasts() {
                    self.runtime
                        .broadcast_to_all(&JsonRpcLiteOutbound::Notification(notif));
                }
                Ok(None)
            }
            JsonRpcLiteClientMessage::Request(req) => {
                let req_id = req.id.clone();
                let waiter_token = self.next_waiter_token.fetch_add(1, Ordering::Relaxed);
                {
                    let mut in_flight = self.in_flight.lock();
                    if in_flight.contains_key(&req_id) {
                        return Err(
                            "A JSON-RPC request with this id is already pending.".to_owned()
                        );
                    }
                    in_flight.insert(req_id.clone(), waiter_token);
                }

                struct InFlightGuard<'a> {
                    conn: &'a H3DeviceConnection,
                    id: JsonRpcLiteId,
                    token: u64,
                }
                impl Drop for InFlightGuard<'_> {
                    fn drop(&mut self) {
                        let mut guard = self.conn.in_flight.lock();
                        if guard.get(&self.id) == Some(&self.token) {
                            guard.remove(&self.id);
                        }
                    }
                }
                let _in_flight_guard = InFlightGuard {
                    conn: self.as_ref(),
                    id: req_id,
                    token: waiter_token,
                };

                let close_notified = self.close_notify.notified();
                tokio::pin!(close_notified);
                if self.closed.load(Ordering::Acquire) {
                    return Err("HTTP JSON-RPC connection closed.".to_owned());
                }

                let dispatch_fut = async {
                    let resp = dispatch_client_message(
                        &self.runtime,
                        &self.conn_state,
                        JsonRpcLiteClientMessage::Request(req),
                    )
                    .await;
                    for notif in self.conn_state.drain_deferred_broadcasts() {
                        self.runtime
                            .broadcast_to_all(&JsonRpcLiteOutbound::Notification(notif));
                    }
                    resp
                };

                let maybe_resp = tokio::select! {
                    _ = &mut close_notified => {
                        return Err("HTTP JSON-RPC connection closed.".to_owned());
                    }
                    _ = tokio::time::sleep(HTTP_RPC_RESPONSE_TIMEOUT) => {
                        return Err("Timed out waiting for JSON-RPC response.".to_owned());
                    }
                    res = dispatch_fut => res,
                };

                let val = maybe_resp
                    .and_then(|r| serde_json::to_value(r).ok())
                    .unwrap_or_else(|| json!({}));
                Ok(Some(val))
            }
        }
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.close_notify.notify_waiters();
        if let Some(t) = self.keepalive_task.lock().take() {
            t.abort();
        }
        self.sinks.lock().clear();
        self.in_flight.lock().clear();
        self.forwarder_task.abort();
        self.runtime
            .remove_connection(&self.conn_state.connection_id);
    }
}

pub struct H3DeviceConnections {
    runtime: Arc<ServerRuntimeState>,
    keepalive_interval: Duration,
    connections: DashMap<String, Arc<H3DeviceConnection>>,
    stream_owners: DashMap<String, u64>,
    next_owner_id: AtomicU64,
}

impl H3DeviceConnections {
    pub fn new(runtime: Arc<ServerRuntimeState>, keepalive_interval: Duration) -> Arc<Self> {
        Arc::new(Self {
            runtime,
            keepalive_interval,
            connections: DashMap::new(),
            stream_owners: DashMap::new(),
            next_owner_id: AtomicU64::new(1),
        })
    }

    pub fn get_or_create(&self, device_id: &str) -> Arc<H3DeviceConnection> {
        if let Some(existing) = self.connections.get(device_id) {
            return Arc::clone(existing.value());
        }
        self.connections
            .entry(device_id.to_owned())
            .or_insert_with(|| {
                H3DeviceConnection::new(Arc::clone(&self.runtime), self.keepalive_interval)
            })
            .value()
            .clone()
    }

    pub fn is_current(&self, device_id: &str, expected: &Arc<H3DeviceConnection>) -> bool {
        self.connections
            .get(device_id)
            .is_some_and(|c| Arc::ptr_eq(c.value(), expected))
    }

    pub fn open_sse_stream(self: &Arc<Self>, device_id: &str) -> SseDeviceEventStream {
        let connection = self.get_or_create(device_id);
        let owner_id = self.next_owner_id.fetch_add(1, Ordering::Relaxed);
        self.stream_owners.insert(device_id.to_owned(), owner_id);
        let (sink_id, rx) = connection.add_event_sink();
        SseDeviceEventStream {
            manager: Arc::clone(self),
            device_id: device_id.to_owned(),
            connection,
            owner_id,
            sink_id,
            rx,
        }
    }

    pub fn close(&self, device_id: &str) {
        self.stream_owners.remove(device_id);
        if let Some((_, conn)) = self.connections.remove(device_id) {
            conn.close();
        }
    }

    pub fn close_all(&self) {
        self.stream_owners.clear();
        let all: Vec<Arc<H3DeviceConnection>> = self
            .connections
            .iter()
            .map(|e| Arc::clone(e.value()))
            .collect();
        self.connections.clear();
        for conn in all {
            conn.close();
        }
    }
}

pub struct SseDeviceEventStream {
    manager: Arc<H3DeviceConnections>,
    device_id: String,
    connection: Arc<H3DeviceConnection>,
    owner_id: u64,
    sink_id: u64,
    rx: mpsc::UnboundedReceiver<Bytes>,
}

impl Stream for SseDeviceEventStream {
    type Item = Result<Bytes, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.rx.poll_recv(cx) {
            Poll::Ready(Some(bytes)) => Poll::Ready(Some(Ok(bytes))),
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for SseDeviceEventStream {
    fn drop(&mut self) {
        self.connection.remove_event_sink(self.sink_id);
        let is_owner = self
            .manager
            .stream_owners
            .get(&self.device_id)
            .is_some_and(|o| *o.value() == self.owner_id);
        if !is_owner {
            return;
        }
        self.manager.stream_owners.remove(&self.device_id);
        if self.manager.is_current(&self.device_id, &self.connection) {
            self.manager.close(&self.device_id);
        }
    }
}
