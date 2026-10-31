use std::collections::VecDeque;

use cowork_protocol::{JsonRpcLiteError, TurnAttachmentInputPart, error_codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const MAX_IDEMPOTENCY_ENTRIES: usize = 256;

#[derive(Debug, Clone)]
pub struct AcceptedTurnRecord {
    pub client_message_id: String,
    pub turn_id: String,
    pub payload_fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct IdempotencyCheckOutcome {
    pub turn_id: String,
    pub payload_fingerprint: String,
    pub was_duplicate: bool,
}

#[derive(Default)]
pub struct TurnIdempotencyLedger {
    records: Mutex<VecDeque<AcceptedTurnRecord>>,
}

impl TurnIdempotencyLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn fingerprint_input(text: &str, attachments: &[TurnAttachmentInputPart]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(text.as_bytes());
        hasher.update([0u8]);
        if let Ok(att_bytes) = serde_json::to_vec(attachments) {
            hasher.update(&att_bytes);
        }
        hex::encode(hasher.finalize())
    }

    pub fn hydrate_from_journal_payload(&self, payload: &Value) {
        let Some(cid) = payload
            .get("clientMessageId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let Some(turn_id) = payload
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return;
        };
        let fp = payload
            .get("payloadFingerprint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let mut guard = self.records.lock();
        if guard.iter().any(|r| r.client_message_id == cid) {
            return;
        }
        if guard.len() >= MAX_IDEMPOTENCY_ENTRIES {
            guard.pop_front();
        }
        guard.push_back(AcceptedTurnRecord {
            client_message_id: cid.to_owned(),
            turn_id: turn_id.to_owned(),
            payload_fingerprint: fp,
        });
    }

    pub fn build_journal_payload(
        client_message_id: &str,
        turn_id: &str,
        payload_fingerprint: &str,
    ) -> Value {
        json!({
            "clientMessageId": client_message_id,
            "turnId": turn_id,
            "payloadFingerprint": payload_fingerprint,
        })
    }

    pub fn lookup_existing(
        &self,
        client_message_id: &str,
        text: &str,
        attachments: &[TurnAttachmentInputPart],
    ) -> Result<Option<IdempotencyCheckOutcome>, JsonRpcLiteError> {
        let cid = client_message_id.trim();
        if cid.is_empty() {
            return Ok(None);
        }
        let fp = Self::fingerprint_input(text, attachments);
        let guard = self.records.lock();
        if let Some(existing) = guard.iter().find(|r| r.client_message_id == cid) {
            if existing.payload_fingerprint == fp || existing.payload_fingerprint.is_empty() {
                return Ok(Some(IdempotencyCheckOutcome {
                    turn_id: existing.turn_id.clone(),
                    payload_fingerprint: fp,
                    was_duplicate: true,
                }));
            }
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "clientMessageId '{cid}' was already used with a different turn payload on this thread."
                ),
            ));
        }
        Ok(None)
    }

    pub fn check_or_record(
        &self,
        client_message_id: &str,
        proposed_turn_id: &str,
        text: &str,
        attachments: &[TurnAttachmentInputPart],
    ) -> Result<IdempotencyCheckOutcome, JsonRpcLiteError> {
        let cid = client_message_id.trim();
        let fp = Self::fingerprint_input(text, attachments);
        if cid.is_empty() {
            return Ok(IdempotencyCheckOutcome {
                turn_id: proposed_turn_id.to_owned(),
                payload_fingerprint: fp,
                was_duplicate: false,
            });
        }

        let mut guard = self.records.lock();
        if let Some(existing) = guard.iter().find(|r| r.client_message_id == cid) {
            if existing.payload_fingerprint == fp || existing.payload_fingerprint.is_empty() {
                return Ok(IdempotencyCheckOutcome {
                    turn_id: existing.turn_id.clone(),
                    payload_fingerprint: fp,
                    was_duplicate: true,
                });
            }
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!(
                    "clientMessageId '{cid}' was already used with a different turn payload on this thread."
                ),
            ));
        }

        if guard.len() >= MAX_IDEMPOTENCY_ENTRIES {
            guard.pop_front();
        }
        guard.push_back(AcceptedTurnRecord {
            client_message_id: cid.to_owned(),
            turn_id: proposed_turn_id.to_owned(),
            payload_fingerprint: fp.clone(),
        });
        Ok(IdempotencyCheckOutcome {
            turn_id: proposed_turn_id.to_owned(),
            payload_fingerprint: fp,
            was_duplicate: false,
        })
    }
}
