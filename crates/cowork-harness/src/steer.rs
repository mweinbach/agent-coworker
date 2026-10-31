use std::collections::VecDeque;
use std::sync::Arc;

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
}

#[derive(Debug, Clone)]
struct SteerIdempotencyRecord {
    client_message_id: String,
    text: String,
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
    queue: Mutex<VecDeque<SteerEntry>>,
    idempotency: Mutex<VecDeque<SteerIdempotencyRecord>>,
    codex_binding: Mutex<Option<ActiveCodexBinding>>,
}

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
            queue: Mutex::new(VecDeque::new()),
            idempotency: Mutex::new(VecDeque::new()),
            codex_binding: Mutex::new(None),
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
        let trimmed = text.trim().to_owned();
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
                if prev.text == trimmed {
                    return Ok(json!({
                        "accepted": true,
                        "alreadyAccepted": true,
                        "turnId": self.turn_id,
                        "steerRequestId": prev.request_id,
                    }));
                }
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_REQUEST,
                    format!("Steer clientMessageId '{cid}' was already used with different text."),
                ));
            }
            let req_id = format!("steer_{}", Uuid::new_v4());
            if ledger.len() >= 128 {
                ledger.pop_front();
            }
            ledger.push_back(SteerIdempotencyRecord {
                client_message_id: cid.to_owned(),
                text: trimmed.clone(),
                request_id: req_id.clone(),
            });
            drop(ledger);
            return self.push_entry(SteerEntry {
                request_id: req_id,
                text: trimmed,
                client_message_id: Some(cid.to_owned()),
            });
        }

        let req_id = format!("steer_{}", Uuid::new_v4());
        self.push_entry(SteerEntry {
            request_id: req_id,
            text: trimmed,
            client_message_id: None,
        })
    }

    fn push_entry(&self, entry: SteerEntry) -> Result<Value, JsonRpcLiteError> {
        let req_id = entry.request_id.clone();
        let text_for_codex = entry.text.clone();
        self.queue.lock().push_back(entry.clone());

        self.sink.send_notification(
            "cowork/session/steerAccepted",
            json!({
                "threadId": self.thread_id,
                "turnId": self.turn_id,
                "steerRequestId": req_id,
                "clientMessageId": entry.client_message_id,
                "text": entry.text,
            }),
        );

        // If bound to a live Codex App-Server turn, also forward `turn/steer` over stdio!
        if let Some(binding) = self.codex_binding.lock().clone()
            && let Some(expected_turn_id) = binding.codex_turn_id
        {
            tokio::spawn(async move {
                let _ = binding
                    .client
                    .steer_turn(CodexTurnSteerParams {
                        thread_id: binding.codex_thread_id,
                        expected_turn_id,
                        input_text: text_for_codex,
                    })
                    .await;
            });
        }

        Ok(json!({
            "accepted": true,
            "turnId": self.turn_id,
            "steerRequestId": req_id,
        }))
    }

    pub fn drain_pending(&self) -> Vec<SteerEntry> {
        self.queue.lock().drain(..).collect()
    }

    pub fn has_pending(&self) -> bool {
        !self.queue.lock().is_empty()
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
