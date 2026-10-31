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
use serde_json::{Map, Value, json};
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
        tx: oneshot::Sender<Result<String, String>>,
    },
}

struct CompletedReceipt {
    request_id: String,
    normalized_response: Value,
    recorded_at: Instant,
}

pub struct InteractionManager {
    thread_id: String,
    turn_id: Option<String>,
    sink: Arc<dyn HarnessEventSink>,
    yolo: bool,
    require_file_change_approval: bool,
    pending: Mutex<HashMap<String, PendingPrompt>>,
    receipts: Mutex<VecDeque<CompletedReceipt>>,
}

impl InteractionManager {
    pub fn new(thread_id: impl Into<String>, sink: Arc<dyn HarnessEventSink>) -> Self {
        Self {
            thread_id: thread_id.into(),
            turn_id: None,
            sink,
            yolo: false,
            require_file_change_approval: false,
            pending: Mutex::new(HashMap::new()),
            receipts: Mutex::new(VecDeque::new()),
        }
    }

    pub fn with_turn_id(mut self, turn_id: impl Into<String>) -> Self {
        let tid = turn_id.into();
        if !tid.trim().is_empty() {
            self.turn_id = Some(tid);
        }
        self
    }

    pub fn with_yolo(mut self, yolo: bool) -> Self {
        self.yolo = yolo;
        self
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
            let fallback_response = match prompt {
                PendingPrompt::Approval { tx, .. } => {
                    let _ = tx.send(Err(reason.to_owned()));
                    json!({ "kind": "approval", "approved": false })
                }
                PendingPrompt::UserInput { tx, .. } => {
                    let _ = tx.send(Err(reason.to_owned()));
                    json!({ "kind": "ask", "answer": ASK_SKIP_TOKEN })
                }
            };
            self.sink.send_notification(
                "serverRequest/resolved",
                json!({
                    "threadId": self.thread_id,
                    "requestId": req_id,
                    "response": fallback_response,
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
                let kind = prev
                    .normalized_response
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let candidate = match kind {
                    "approval" => parse_approval_decision(result)
                        .map(|approved| json!({ "kind": "approval", "approved": approved })),
                    "ask" => parse_single_user_input_answer(result)
                        .ok()
                        .map(|answer| json!({ "kind": "ask", "answer": answer })),
                    _ => None,
                };
                if candidate.as_ref() == Some(&prev.normalized_response) {
                    return Ok(json!({
                        "requestId": request_id,
                        "status": "already_applied",
                        "response": prev.normalized_response,
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

        let normalized_response = match entry {
            PendingPrompt::Approval { method, params, tx } => {
                match parse_approval_decision(result) {
                    Some(approved) => {
                        let _ = tx.send(Ok(approved));
                        json!({ "kind": "approval", "approved": approved })
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
            PendingPrompt::UserInput { method, params, tx } => {
                match parse_single_user_input_answer(result) {
                    Ok(answer) => {
                        let _ = tx.send(Ok(answer.clone()));
                        json!({ "kind": "ask", "answer": answer })
                    }
                    Err(validation_msg) => {
                        // Put the prompt back and re-emit so the user can retry or skip!
                        pending_guard.insert(
                            request_id.to_owned(),
                            PendingPrompt::UserInput {
                                method: method.clone(),
                                params: params.clone(),
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
        };
        drop(pending_guard);

        {
            let mut receipts = self.receipts.lock();
            if receipts.len() >= MAX_RECEIPT_LEDGER_SIZE {
                receipts.pop_front();
            }
            receipts.push_back(CompletedReceipt {
                request_id: request_id.to_owned(),
                normalized_response: normalized_response.clone(),
                recorded_at: Instant::now(),
            });
        }

        self.sink.send_notification(
            "serverRequest/resolved",
            json!({
                "threadId": self.thread_id,
                "requestId": request_id,
                "response": normalized_response,
            }),
        );

        Ok(json!({
            "requestId": request_id,
            "status": "applied",
            "response": normalized_response,
        }))
    }

    fn build_base_request_params(&self, request_id: &str, item_id: String) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("threadId".to_owned(), Value::String(self.thread_id.clone()));
        if let Some(ref tid) = self.turn_id {
            map.insert("turnId".to_owned(), Value::String(tid.clone()));
        }
        map.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
        map.insert("itemId".to_owned(), Value::String(item_id));
        map
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

fn parse_single_user_input_answer(result: &Value) -> Result<String, String> {
    if result.get("skipped").and_then(Value::as_bool) == Some(true) {
        return Ok(ASK_SKIP_TOKEN.to_owned());
    }

    if let Some(ans_str) = result.get("answer").and_then(Value::as_str) {
        if ans_str.trim().is_empty() {
            return Err(format!(
                "Answer cannot be empty. Provide a response or '{ASK_SKIP_TOKEN}' to skip."
            ));
        }
        return Ok(ans_str.to_owned());
    }

    if let Some(s) = result.as_str() {
        if s.trim().is_empty() {
            return Err(format!(
                "Answer cannot be empty. Provide a response or '{ASK_SKIP_TOKEN}' to skip."
            ));
        }
        return Ok(s.to_owned());
    }

    if let Some(ans_obj) = result.get("answers").and_then(Value::as_object)
        && let Some((_, val)) = ans_obj.iter().next()
    {
        let extracted = match val {
            Value::String(s) => s.clone(),
            Value::Object(o) => o
                .get("answers")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            Value::Array(a) => a
                .first()
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            _ => String::new(),
        };
        if extracted.trim().is_empty() {
            return Err(format!(
                "Answer cannot be empty. Provide a response or '{ASK_SKIP_TOKEN}' to skip."
            ));
        }
        return Ok(extracted);
    }

    Err("User input response must include 'answer' or 'skipped: true'.".to_owned())
}

#[async_trait]
impl ApprovalHandler for InteractionManager {
    async fn approve_command(&self, req: ApprovalDecisionRequest) -> Result<bool, String> {
        if self.yolo {
            return Ok(true);
        }
        let request_id = format!("req_cmd_{}", Uuid::new_v4());
        let method = "item/commandExecution/requestApproval".to_owned();
        let is_sandbox_escalation = req.reason == "sandbox_denied";
        let reason = if is_sandbox_escalation {
            "sandbox_denied_escalation".to_owned()
        } else if req.reason.trim().is_empty() {
            "requires_manual_review".to_owned()
        } else {
            req.reason
        };

        let mut params_map =
            self.build_base_request_params(&request_id, format!("commandExecution:{request_id}"));
        params_map.insert("command".to_owned(), Value::String(req.command));
        params_map.insert("dangerous".to_owned(), Value::Bool(true));
        params_map.insert("reason".to_owned(), Value::String(reason));
        if let Some(detail) = req.detail.filter(|s| !s.trim().is_empty()) {
            params_map.insert("detail".to_owned(), Value::String(detail));
        }
        if let Some(cat) = req
            .category
            .filter(|c| matches!(c.as_str(), "filesystem" | "network"))
        {
            params_map.insert("category".to_owned(), Value::String(cat));
        }
        let params = Value::Object(params_map);

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
        if self.yolo || !self.require_file_change_approval {
            return Ok(true);
        }
        let request_id = format!("req_file_{}", Uuid::new_v4());
        let method = "item/commandExecution/requestApproval".to_owned();
        let reason_str = reason
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("requires_manual_review")
            .to_owned();

        let mut params_map =
            self.build_base_request_params(&request_id, format!("commandExecution:{request_id}"));
        params_map.insert(
            "command".to_owned(),
            Value::String(format!("apply_patch {}", path.display())),
        );
        params_map.insert("dangerous".to_owned(), Value::Bool(false));
        params_map.insert("reason".to_owned(), Value::String(reason_str));
        params_map.insert(
            "detail".to_owned(),
            Value::String(format!("Modify file {}", path.display())),
        );
        params_map.insert(
            "category".to_owned(),
            Value::String("filesystem".to_owned()),
        );
        let params = Value::Object(params_map);

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
        let request_id = format!("req_ask_{}", Uuid::new_v4());
        let method = "item/tool/requestUserInput".to_owned();
        let mut params_map =
            self.build_base_request_params(&request_id, format!("requestUserInput:{request_id}"));
        params_map.insert("question".to_owned(), Value::String(question.to_owned()));
        if let Some(opts) = options {
            params_map.insert(
                "options".to_owned(),
                Value::Array(opts.into_iter().map(Value::String).collect()),
            );
        }
        let params = Value::Object(params_map);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(
            request_id.clone(),
            PendingPrompt::UserInput {
                method: method.clone(),
                params: params.clone(),
                tx,
            },
        );
        self.sink.send_server_request(&request_id, &method, params);
        rx.await
            .map_err(|_| "User input prompt cancelled.".to_owned())?
    }

    async fn ask_user_structured(
        &self,
        questions: Vec<StructuredUserQuestion>,
    ) -> Result<BTreeMap<String, String>, String> {
        let mut out = BTreeMap::new();
        for q in questions {
            let opt_labels = q
                .options
                .map(|opts| opts.into_iter().map(|o| o.label).collect::<Vec<_>>());
            let ans = self.ask_user(&q.question, opt_labels).await?;
            out.insert(q.id, ans);
        }
        Ok(out)
    }
}
