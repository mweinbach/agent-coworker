use std::collections::VecDeque;

use cowork_protocol::{JsonRpcLiteError, TurnAttachmentInputPart, error_codes};
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// In-memory cache size per thread. The durable journal (`internal/userMessageAccepted`
/// receipts) stays authoritative: once the cache has evicted anything, a miss is resolved
/// against it before a new turn is admitted (`*_with_journal`).
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
struct LedgerCache {
    /// Least recently used first.
    records: VecDeque<AcceptedTurnRecord>,
    /// The cache has dropped at least one accepted receipt, so a miss is not authoritative.
    evicted: bool,
}

impl LedgerCache {
    fn find(&mut self, cid: &str) -> Option<AcceptedTurnRecord> {
        let idx = self
            .records
            .iter()
            .position(|r| r.client_message_id == cid)?;
        let record = self.records.remove(idx)?;
        self.records.push_back(record.clone());
        Some(record)
    }

    fn insert(&mut self, record: AcceptedTurnRecord) {
        while self.records.len() >= MAX_IDEMPOTENCY_ENTRIES {
            self.records.pop_front();
            self.evicted = true;
        }
        self.records.push_back(record);
    }
}

#[derive(Default)]
pub struct TurnIdempotencyLedger {
    cache: Mutex<LedgerCache>,
}

impl TurnIdempotencyLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Marks the cache as possibly missing accepted keys (e.g. journal hydration failed), so
    /// every miss consults the durable journal.
    pub fn mark_incomplete(&self) {
        self.cache.lock().evicted = true;
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
        let mut guard = self.cache.lock();
        // The first acceptance of a key is canonical.
        if guard.records.iter().any(|r| r.client_message_id == cid) {
            return;
        }
        guard.insert(AcceptedTurnRecord {
            client_message_id: cid.to_owned(),
            turn_id: turn_id.to_owned(),
            payload_fingerprint: fp,
        });
    }

    /// On a cache miss after eviction, loads the key's durable receipt (the
    /// `internal/userMessageAccepted` journal payload) via `load_receipt` into the cache.
    fn ensure_cached(&self, cid: &str, load_receipt: impl FnOnce(&str) -> Option<Value>) {
        {
            let guard = self.cache.lock();
            if !guard.evicted || guard.records.iter().any(|r| r.client_message_id == cid) {
                return;
            }
        }
        if let Some(payload) = load_receipt(cid) {
            self.hydrate_from_journal_payload(&payload);
        }
    }

    fn classify(
        existing: AcceptedTurnRecord,
        cid: &str,
        fp: String,
    ) -> Result<IdempotencyCheckOutcome, JsonRpcLiteError> {
        if existing.payload_fingerprint == fp || existing.payload_fingerprint.is_empty() {
            return Ok(IdempotencyCheckOutcome {
                turn_id: existing.turn_id,
                payload_fingerprint: fp,
                was_duplicate: true,
            });
        }
        Err(JsonRpcLiteError::new(
            error_codes::INVALID_REQUEST,
            format!(
                "clientMessageId '{cid}' was already used with a different turn payload on this thread."
            ),
        ))
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
        self.lookup_existing_with_journal(client_message_id, text, attachments, |_| None)
    }

    /// Like [`Self::lookup_existing`], consulting `load_receipt` (the durable journal) when the
    /// key is not cached and the cache can no longer prove it was never accepted.
    pub fn lookup_existing_with_journal(
        &self,
        client_message_id: &str,
        text: &str,
        attachments: &[TurnAttachmentInputPart],
        load_receipt: impl FnOnce(&str) -> Option<Value>,
    ) -> Result<Option<IdempotencyCheckOutcome>, JsonRpcLiteError> {
        let cid = client_message_id.trim();
        if cid.is_empty() {
            return Ok(None);
        }
        self.ensure_cached(cid, load_receipt);
        let fp = Self::fingerprint_input(text, attachments);
        let existing = self.cache.lock().find(cid);
        existing
            .map(|existing| Self::classify(existing, cid, fp))
            .transpose()
    }

    pub fn check_or_record(
        &self,
        client_message_id: &str,
        proposed_turn_id: &str,
        text: &str,
        attachments: &[TurnAttachmentInputPart],
    ) -> Result<IdempotencyCheckOutcome, JsonRpcLiteError> {
        self.check_or_record_with_journal(
            client_message_id,
            proposed_turn_id,
            text,
            attachments,
            |_| None,
        )
    }

    /// Like [`Self::check_or_record`], consulting `load_receipt` (the durable journal) on a
    /// non-authoritative cache miss so an evicted key replays its original turn instead of
    /// admitting a new one.
    pub fn check_or_record_with_journal(
        &self,
        client_message_id: &str,
        proposed_turn_id: &str,
        text: &str,
        attachments: &[TurnAttachmentInputPart],
        load_receipt: impl FnOnce(&str) -> Option<Value>,
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
        self.ensure_cached(cid, load_receipt);

        let mut guard = self.cache.lock();
        if let Some(existing) = guard.find(cid) {
            return Self::classify(existing, cid, fp);
        }
        guard.insert(AcceptedTurnRecord {
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
