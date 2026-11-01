use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use cowork_inference::ContentBlock;
use cowork_protocol::{JsonRpcLiteError, error_codes};
use cowork_providers::codex_app_server::{
    CodexAppServerClient, CodexTurnObserver, CodexTurnSteerParams,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::interactions::HarnessEventSink;

#[derive(Debug, Clone)]
pub struct SteerEntry {
    pub request_id: String,
    pub text: String,
    pub client_message_id: Option<String>,
    /// Materialized user content (text + attachment media). Empty means plain `text`.
    pub content: Vec<ContentBlock>,
    /// The live native Codex turn accepted this steer via `turn/steer`, so the provider has
    /// already consumed it: the harness only records it in history and must not resubmit it.
    pub delivered_natively: bool,
}

#[derive(Debug, Clone)]
struct SteerIdempotencyRecord {
    client_message_id: String,
    dedupe_key: String,
    request_id: String,
}

#[derive(Clone)]
struct ActiveCodexBinding {
    client: Arc<CodexAppServerClient>,
    codex_thread_id: String,
    codex_turn_id: Option<String>,
}

pub struct SteerCoordinator {
    thread_id: String,
    turn_id: String,
    sink: Arc<dyn HarnessEventSink>,
    queue: Arc<Mutex<VecDeque<SteerEntry>>>,
    /// Native Codex `turn/steer` requests still awaiting a response.
    native_in_flight: Arc<AtomicUsize>,
    native_settled: Arc<tokio::sync::Notify>,
    idempotency: Mutex<VecDeque<SteerIdempotencyRecord>>,
    codex_binding: Mutex<Option<ActiveCodexBinding>>,
    /// Set once the turn stops admitting steers (it is settling); later `turn/steer` requests are
    /// rejected instead of being queued where nothing would ever drain them.
    admission_closed: AtomicBool,
}

/// Rejection message for steers still queued when a turn is interrupted.
pub const STEER_REJECTED_INTERRUPTED: &str =
    "Turn was interrupted before pending steers could be accepted.";
/// Rejection message for steers still queued when a turn exhausts its step budget.
pub const STEER_REJECTED_MAX_STEPS: &str =
    "Active turn reached its max step budget and can no longer accept steering.";
/// Rejection message for steers still queued when a turn ends for any other reason.
pub const STEER_REJECTED_TURN_ENDED: &str =
    "Active turn ended before pending steers could be accepted.";

impl SteerCoordinator {
    pub fn new(
        thread_id: impl Into<String>,
        turn_id: impl Into<String>,
        sink: Arc<dyn HarnessEventSink>,
        _reserved: Option<()>,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            sink,
            queue: Arc::new(Mutex::new(VecDeque::new())),
            native_in_flight: Arc::new(AtomicUsize::new(0)),
            native_settled: Arc::new(tokio::sync::Notify::new()),
            idempotency: Mutex::new(VecDeque::new()),
            codex_binding: Mutex::new(None),
            admission_closed: AtomicBool::new(false),
        }
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub fn enqueue_steer(
        &self,
        text: String,
        client_message_id: Option<String>,
    ) -> Result<Value, JsonRpcLiteError> {
        self.enqueue_steer_with_content(text, Vec::new(), None, client_message_id)
    }

    /// Enqueues a steer whose user message carries structured `content` (e.g. materialized
    /// attachments). `dedupe_key` identifies the raw payload for `clientMessageId` replay checks
    /// (defaults to the trimmed text).
    pub fn enqueue_steer_with_content(
        &self,
        text: String,
        content: Vec<ContentBlock>,
        dedupe_key: Option<String>,
        client_message_id: Option<String>,
    ) -> Result<Value, JsonRpcLiteError> {
        let trimmed = text.trim().to_owned();
        let dedupe_key = dedupe_key.unwrap_or_else(|| trimmed.clone());
        if trimmed.is_empty() {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_PARAMS,
                "Steer message text must not be empty.",
            ));
        }

        if let Some(cid) = client_message_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let mut ledger = self.idempotency.lock();
            if let Some(prev) = ledger.iter().find(|r| r.client_message_id == cid) {
                if prev.dedupe_key == dedupe_key {
                    return Ok(json!({
                        "turnId": self.turn_id,
                        "steerRequestId": prev.request_id,
                        "replayed": true,
                    }));
                }
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_REQUEST,
                    format!("Steer clientMessageId '{cid}' was already used with different text."),
                ));
            }
            self.ensure_admission_open()?;
            let req_id = format!("steer_{}", Uuid::new_v4());
            if ledger.len() >= 128 {
                ledger.pop_front();
            }
            ledger.push_back(SteerIdempotencyRecord {
                client_message_id: cid.to_owned(),
                dedupe_key,
                request_id: req_id.clone(),
            });
            drop(ledger);
            return self.push_entry(SteerEntry {
                request_id: req_id,
                text: trimmed,
                client_message_id: Some(cid.to_owned()),
                content,
                delivered_natively: false,
            });
        }

        self.ensure_admission_open()?;
        let req_id = format!("steer_{}", Uuid::new_v4());
        self.push_entry(SteerEntry {
            request_id: req_id,
            text: trimmed,
            client_message_id: None,
            content,
            delivered_natively: false,
        })
    }

    fn ensure_admission_open(&self) -> Result<(), JsonRpcLiteError> {
        if self.admission_closed.load(Ordering::SeqCst) {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                "Active turn no longer accepts steering.",
            ));
        }
        Ok(())
    }

    /// Stops admitting new steers. Called when the turn starts settling so a steer accepted after
    /// the final drain cannot be silently lost.
    pub fn close_admission(&self) {
        self.admission_closed.store(true, Ordering::SeqCst);
    }

    pub fn is_admission_closed(&self) -> bool {
        self.admission_closed.load(Ordering::SeqCst)
    }

    fn push_entry(&self, entry: SteerEntry) -> Result<Value, JsonRpcLiteError> {
        let req_id = entry.request_id.clone();
        let text_for_codex = entry.text.clone();
        self.queue.lock().push_back(entry.clone());

        let mut notif = serde_json::Map::new();
        notif.insert(
            "type".to_owned(),
            Value::String("steer_accepted".to_owned()),
        );
        notif.insert(
            "sessionId".to_owned(),
            Value::String(self.thread_id.clone()),
        );
        notif.insert("turnId".to_owned(), Value::String(self.turn_id.clone()));
        notif.insert("steerRequestId".to_owned(), Value::String(req_id.clone()));
        notif.insert("text".to_owned(), Value::String(entry.text));
        if let Some(cid) = entry.client_message_id {
            notif.insert("clientMessageId".to_owned(), Value::String(cid));
        }

        self.sink
            .send_notification("cowork/session/steerAccepted", Value::Object(notif));

        // If bound to a live Codex App-Server turn, also forward `turn/steer` over stdio!
        if let Some(binding) = self.codex_binding.lock().clone()
            && let Some(expected_turn_id) = binding.codex_turn_id
        {
            let queue = Arc::clone(&self.queue);
            let in_flight = Arc::clone(&self.native_in_flight);
            let settled = Arc::clone(&self.native_settled);
            let steer_req_id = req_id.clone();
            in_flight.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let accepted = binding
                    .client
                    .steer_turn(CodexTurnSteerParams {
                        thread_id: binding.codex_thread_id,
                        expected_turn_id,
                        input_text: text_for_codex,
                    })
                    .await
                    .is_ok();
                if accepted
                    && let Some(e) = queue
                        .lock()
                        .iter_mut()
                        .find(|e| e.request_id == steer_req_id)
                {
                    e.delivered_natively = true;
                }
                in_flight.fetch_sub(1, Ordering::SeqCst);
                settled.notify_waiters();
            });
        }

        Ok(json!({
            "turnId": self.turn_id,
            "steerRequestId": req_id,
        }))
    }

    /// Drains every queued steer. Entries with `delivered_natively` were already consumed by
    /// the native Codex turn and must only be recorded, not resubmitted.
    pub fn drain_pending(&self) -> Vec<SteerEntry> {
        self.queue.lock().drain(..).collect()
    }

    /// Waits (bounded) for in-flight native `turn/steer` requests to resolve so each queued
    /// entry is known to be either natively delivered or still owed to the provider.
    pub async fn settle_native_deliveries(&self) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while self.native_in_flight.load(Ordering::SeqCst) > 0 {
            let notified = self.native_settled.notified();
            if self.native_in_flight.load(Ordering::SeqCst) == 0 {
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                break;
            }
        }
    }

    /// Removes and returns the steers the native Codex turn already accepted.
    pub fn take_natively_delivered(&self) -> Vec<SteerEntry> {
        let mut q = self.queue.lock();
        let (delivered, rest): (Vec<_>, Vec<_>) = q.drain(..).partition(|e| e.delivered_natively);
        q.extend(rest);
        delivered
    }

    /// Whether a steer is still owed to the provider (natively delivered ones are not).
    pub fn has_pending(&self) -> bool {
        self.queue.lock().iter().any(|e| !e.delivered_natively)
    }

    /// Test hook: marks a queued steer as accepted by the native Codex turn.
    #[doc(hidden)]
    pub fn mark_natively_delivered_for_tests(&self, request_id: &str) {
        if let Some(e) = self
            .queue
            .lock()
            .iter_mut()
            .find(|e| e.request_id == request_id)
        {
            e.delivered_natively = true;
        }
    }

    pub fn interrupt_codex_if_bound(&self) {
        if let Some(binding) = self.codex_binding.lock().clone() {
            tokio::spawn(async move {
                let _ = binding
                    .client
                    .interrupt_turn(&binding.codex_thread_id, binding.codex_turn_id.as_deref())
                    .await;
            });
        }
    }
}

impl CodexTurnObserver for SteerCoordinator {
    fn on_turn_started(
        &self,
        client: Arc<CodexAppServerClient>,
        codex_thread_id: &str,
        codex_turn_id: Option<&str>,
    ) {
        *self.codex_binding.lock() = Some(ActiveCodexBinding {
            client,
            codex_thread_id: codex_thread_id.to_owned(),
            codex_turn_id: codex_turn_id.map(str::to_owned),
        });
    }
}
