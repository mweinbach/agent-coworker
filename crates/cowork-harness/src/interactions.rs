use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_protocol::{JsonRpcLiteError, error_codes};
use cowork_tools::{
    ASK_SKIP_TOKEN, ApprovalDecisionRequest, ApprovalHandler, StructuredUserQuestion,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use uuid::Uuid;

const MAX_RECEIPT_LEDGER_SIZE: usize = 128;
const RECEIPT_TTL: Duration = Duration::from_secs(300);

pub trait HarnessEventSink: Send + Sync {
    fn send_notification(&self, method: &str, params: Value);
    fn send_server_request(&self, request_id: &str, method: &str, params: Value);
}

enum PendingPrompt {
    Approval {
        method: String,
        params: Value,
        tx: oneshot::Sender<Result<bool, String>>,
    },
    UserInput {
        method: String,
        params: Value,
        question_ids: Vec<String>,
        tx: oneshot::Sender<Result<BTreeMap<String, String>, String>>,
    },
}

struct CompletedReceipt {
    request_id: String,
    normalized_payload: Value,
    recorded_at: Instant,
}

pub struct InteractionManager {
    thread_id: String,
    sink: Arc<dyn HarnessEventSink>,
    require_file_change_approval: bool,
    pending: Mutex<HashMap<String, PendingPrompt>>,
    receipts: Mutex<VecDeque<CompletedReceipt>>,
}

impl InteractionManager {
    pub fn new(thread_id: impl Into<String>, sink: Arc<dyn HarnessEventSink>) -> Self {
        Self {
            thread_id: thread_id.into(),
            sink,
            require_file_change_approval: false,
            pending: Mutex::new(HashMap::new()),
            receipts: Mutex::new(VecDeque::new()),
        }
    }

    pub fn with_file_change_approval(mut self, required: bool) -> Self {
        self.require_file_change_approval = required;
        self
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn owns_request_id(&self, request_id: &str) -> bool {
        if self.pending.lock().contains_key(request_id) {
            return true;
        }
        let mut receipts = self.receipts.lock();
        let now = Instant::now();
        while receipts
            .front()
            .is_some_and(|r| now.duration_since(r.recorded_at) > RECEIPT_TTL)
        {
            receipts.pop_front();
        }
        receipts.iter().any(|r| r.request_id == request_id)
    }

    pub fn has_pending_approval(&self) -> bool {
        self.pending
            .lock()
            .values()
            .any(|p| matches!(p, PendingPrompt::Approval { .. }))
    }

    pub fn has_pending_ask(&self) -> bool {
        self.pending
            .lock()
            .values()
            .any(|p| matches!(p, PendingPrompt::UserInput { .. }))
    }

    pub fn replay_pending_requests(&self) {
        let items: Vec<(String, String, Value)> = self
            .pending
            .lock()
            .iter()
            .map(|(id, p)| match p {
                PendingPrompt::Approval { method, params, .. }
                | PendingPrompt::UserInput { method, params, .. } => {
                    (id.clone(), method.clone(), params.clone())
                }
            })
            .collect();
        for (id, method, params) in items {
            self.sink.send_server_request(&id, &method, params);
        }
    }

    pub fn cancel_all_pending(&self, reason: &str) {
        let drained: Vec<(String, PendingPrompt)> = self.pending.lock().drain().collect();
        for (req_id, prompt) in drained {
            match prompt {
                PendingPrompt::Approval { tx, .. } => {
                    let _ = tx.send(Err(reason.to_owned()));
                }
                PendingPrompt::UserInput { tx, .. } => {
                    let _ = tx.send(Err(reason.to_owned()));
                }
            }
            self.sink.send_notification(
                "serverRequest/resolved",
                json!({
                    "threadId": self.thread_id,
                    "requestId": req_id,
                }),
            );
        }
    }

    /// Resolves an inbound client response (`{ id, result }`) for a server-initiated request.
    /// Enforces 5-minute / 128-entry receipt idempotency, rejects conflicting duplicate payloads
    /// (`-32602`), rejects unknown IDs (`-32600`), validates non-empty answers (or `ASK_SKIP_TOKEN`),
    /// and broadcasts `serverRequest/resolved`.
    pub fn resolve_client_response(
        &self,
        request_id: &str,
        result: &Value,
    ) -> Result<Value, JsonRpcLiteError> {
        {
            let mut receipts = self.receipts.lock();
            let now = Instant::now();
            while receipts
                .front()
                .is_some_and(|r| now.duration_since(r.recorded_at) > RECEIPT_TTL)
            {
                receipts.pop_front();
            }
            if let Some(prev) = receipts.iter().find(|r| r.request_id == request_id) {
                if &prev.normalized_payload == result {
                    return Ok(json!({
                        "requestId": request_id,
                        "status": "already_applied",
                    }));
                }
                return Err(JsonRpcLiteError::new(
                    error_codes::INVALID_PARAMS,
                    format!("Conflicting duplicate response for server request '{request_id}'."),
                ));
            }
        }

        let mut pending_guard = self.pending.lock();
        let Some(entry) = pending_guard.remove(request_id) else {
            return Err(JsonRpcLiteError::new(
                error_codes::INVALID_REQUEST,
                format!("Unknown or expired server requestId '{request_id}'."),
            ));
        };

        match entry {
            PendingPrompt::Approval { method, params, tx } => {
                match parse_approval_decision(result) {
                    Some(approved) => {
                        let _ = tx.send(Ok(approved));
                    }
                    None => {
                        pending_guard.insert(
                            request_id.to_owned(),
                            PendingPrompt::Approval { method, params, tx },
                        );
                        return Err(JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            "Approval response must include boolean 'approved' or 'decision' ('accept'/'decline').",
                        ));
                    }
                }
            }
            PendingPrompt::UserInput {
                method,
                params,
                question_ids,
                tx,
            } => {
                match parse_user_input_answers(result, &question_ids) {
                    Ok(answers) => {
                        let _ = tx.send(Ok(answers));
                    }
                    Err(validation_msg) => {
                        // Put the prompt back and re-emit so the user can retry or skip!
                        pending_guard.insert(
                            request_id.to_owned(),
                            PendingPrompt::UserInput {
                                method: method.clone(),
                                params: params.clone(),
                                question_ids,
                                tx,
                            },
                        );
                        drop(pending_guard);
                        self.sink.send_server_request(request_id, &method, params);
                        return Err(JsonRpcLiteError::new(
                            error_codes::INVALID_PARAMS,
                            validation_msg,
                        ));
                    }
                }
            }
        }
        drop(pending_guard);

        {
            let mut receipts = self.receipts.lock();
            if receipts.len() >= MAX_RECEIPT_LEDGER_SIZE {
                receipts.pop_front();
            }
            receipts.push_back(CompletedReceipt {
                request_id: request_id.to_owned(),
                normalized_payload: result.clone(),
                recorded_at: Instant::now(),
            });
        }

        self.sink.send_notification(
            "serverRequest/resolved",
            json!({
                "threadId": self.thread_id,
                "requestId": request_id,
            }),
        );

        Ok(json!({
            "requestId": request_id,
            "status": "applied",
        }))
    }
}

fn parse_approval_decision(result: &Value) -> Option<bool> {
    if let Some(b) = result.get("approved").and_then(Value::as_bool) {
        return Some(b);
    }
    if let Some(d) = result.get("decision").and_then(Value::as_str) {
        return match d {
            "accept" | "acceptForSession" | "approve" | "approved" => Some(true),
            "decline" | "reject" | "cancel" | "deny" | "rejected" => Some(false),
            _ => None,
        };
    }
    result.as_bool()
}

fn parse_user_input_answers(
    result: &Value,
    question_ids: &[String],
) -> Result<BTreeMap<String, String>, String> {
    if result.get("skipped").and_then(Value::as_bool) == Some(true) {
        let mut map = BTreeMap::new();
        for id in question_ids {
            map.insert(id.clone(), ASK_SKIP_TOKEN.to_owned());
        }
        return Ok(map);
    }

    if let Some(ans_str) = result.get("answer").and_then(Value::as_str) {
        if ans_str.trim().is_empty() {
            return Err(format!(
                "Answer cannot be empty. Provide a response or '{ASK_SKIP_TOKEN}' to skip."
            ));
        }
        let mut map = BTreeMap::new();
        let key = question_ids
            .first()
            .cloned()
            .unwrap_or_else(|| "q_1".to_owned());
        map.insert(key, ans_str.to_owned());
        return Ok(map);
    }

    if let Some(ans_obj) = result.get("answers").and_then(Value::as_object) {
        let mut map = BTreeMap::new();
        for id in question_ids {
            let val = ans_obj.get(id);
            let extracted = match val {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Object(o)) => o
                    .get("answers")
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                Some(Value::Array(a)) => a
                    .first()
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                _ => String::new(),
            };
            if extracted.trim().is_empty() {
                return Err(format!(
                    "Answer for '{id}' cannot be empty. Provide text or '{ASK_SKIP_TOKEN}' to skip."
                ));
            }
            map.insert(id.clone(), extracted);
        }
        return Ok(map);
    }

    Err("User input response must include 'answer', 'answers', or 'skipped: true'.".to_owned())
}

#[async_trait]
impl ApprovalHandler for InteractionManager {
    async fn approve_command(&self, req: ApprovalDecisionRequest) -> Result<bool, String> {
        let request_id = format!("req_cmd_{}", Uuid::new_v4());
        let method = "item/commandExecution/requestApproval".to_owned();
        let params = json!({
            "threadId": self.thread_id,
            "itemId": request_id,
            "command": req.command,
            "cwd": req.cwd.to_string_lossy(),
            "reason": req.reason,
            "category": req.category,
            "detail": req.detail,
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            request_id.clone(),
            PendingPrompt::Approval {
                method: method.clone(),
                params: params.clone(),
                tx,
            },
        );
        self.sink.send_server_request(&request_id, &method, params);
        rx.await
            .map_err(|_| "Approval prompt cancelled.".to_owned())?
    }

    async fn approve_file_change(&self, path: &Path, reason: Option<&str>) -> Result<bool, String> {
        if !self.require_file_change_approval {
            return Ok(true);
        }
        let request_id = format!("req_file_{}", Uuid::new_v4());
        let method = "item/fileChange/requestApproval".to_owned();
        let params = json!({
            "threadId": self.thread_id,
            "itemId": request_id,
            "filePath": path.to_string_lossy(),
            "reason": reason,
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            request_id.clone(),
            PendingPrompt::Approval {
                method: method.clone(),
                params: params.clone(),
                tx,
            },
        );
        self.sink.send_server_request(&request_id, &method, params);
        rx.await
            .map_err(|_| "File approval prompt cancelled.".to_owned())?
    }

    async fn ask_user(
        &self,
        question: &str,
        options: Option<Vec<String>>,
    ) -> Result<String, String> {
        let q = StructuredUserQuestion {
            id: "q_1".to_owned(),
            header: None,
            question: question.to_owned(),
            options: options.map(|opts| {
                opts.into_iter()
                    .map(|label| cowork_tools::StructuredQuestionOption {
                        label,
                        description: None,
                    })
                    .collect()
            }),
            is_other: true,
            is_secret: false,
        };
        let mut map = self.ask_user_structured(vec![q]).await?;
        Ok(map
            .remove("q_1")
            .unwrap_or_else(|| ASK_SKIP_TOKEN.to_owned()))
    }

    async fn ask_user_structured(
        &self,
        questions: Vec<StructuredUserQuestion>,
    ) -> Result<BTreeMap<String, String>, String> {
        let request_id = format!("req_ask_{}", Uuid::new_v4());
        let method = "item/tool/requestUserInput".to_owned();
        let question_ids: Vec<String> = questions.iter().map(|q| q.id.clone()).collect();
        let wire_questions: Vec<Value> = questions
            .iter()
            .map(|q| {
                json!({
                    "id": q.id,
                    "header": q.header,
                    "question": q.question,
                    "isOther": q.is_other,
                    "isSecret": q.is_secret,
                    "options": q.options.as_ref().map(|opts| {
                        opts.iter().map(|o| json!({
                            "label": o.label,
                            "description": o.description,
                        })).collect::<Vec<_>>()
                    })
                })
            })
            .collect();

        let params = json!({
            "threadId": self.thread_id,
            "itemId": request_id,
            "questions": wire_questions,
        });
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            request_id.clone(),
            PendingPrompt::UserInput {
                method: method.clone(),
                params: params.clone(),
                question_ids,
                tx,
            },
        );
        self.sink.send_server_request(&request_id, &method, params);
        rx.await
            .map_err(|_| "User input prompt cancelled.".to_owned())?
    }
}
