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

/// Fail-safe backstop for an abandoned prompt. Transient disconnects are already covered:
/// pending prompts are replayed to a reconnecting client, so this only fires when nobody ever
/// answers (e.g. a headless client died, or a turn was orphaned). On expiry an approval denies
/// and an ask rejects, so the turn unblocks instead of hanging forever and holding the thread
/// busy. Generous by default so a human who steps away is not auto-denied mid-thought.
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

const ASK_TIMEOUT_MESSAGE: &str = "Ask prompt timed out without a response.";

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
    /// `None` disables the abandoned-prompt backstop.
    prompt_timeout: Option<Duration>,
}

#[derive(Clone, Copy)]
enum PromptKind {
    Approval,
    Ask,
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
            prompt_timeout: Some(DEFAULT_PROMPT_TIMEOUT),
        }
    }

    /// Overrides the abandoned-prompt timeout (default [`DEFAULT_PROMPT_TIMEOUT`]). `None` or a
    /// zero duration disables it.
    pub fn with_prompt_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.prompt_timeout = timeout.filter(|d| !d.is_zero());
        self
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

    /// Waits for the client's answer to a pending prompt, bounded by the abandoned-prompt
    /// timeout. On expiry the request is removed, resolved (approval: denied, ask: rejected) and
    /// `serverRequest/resolved` is broadcast so clients drop the stale prompt.
    async fn await_prompt<T>(
        &self,
        request_id: &str,
        kind: PromptKind,
        mut rx: oneshot::Receiver<Result<T, String>>,
        cancelled_message: &str,
    ) -> Result<T, String>
    where
        T: TimedOutPrompt,
    {
        let Some(timeout) = self.prompt_timeout else {
            return rx.await.map_err(|_| cancelled_message.to_owned())?;
        };
        match tokio::time::timeout(timeout, &mut rx).await {
            Ok(res) => res.map_err(|_| cancelled_message.to_owned())?,
            Err(_) => {
                // Only act if still pending: a response (or cancellation) that won the race has
                // already removed the entry and sent on the channel.
                if self.pending.lock().remove(request_id).is_none() {
                    return rx.await.map_err(|_| cancelled_message.to_owned())?;
                }
                let response = match kind {
                    PromptKind::Approval => Some(json!({ "kind": "approval", "approved": false })),
                    PromptKind::Ask => None,
                };
                let mut params = Map::new();
                params.insert("threadId".to_owned(), Value::String(self.thread_id.clone()));
                params.insert("requestId".to_owned(), Value::String(request_id.to_owned()));
                if let Some(response) = response {
                    params.insert("response".to_owned(), response);
                }
                self.sink
                    .send_notification("serverRequest/resolved", Value::Object(params));
                let label = match kind {
                    PromptKind::Approval => "approval",
                    PromptKind::Ask => "ask",
                };
                let suffix = match kind {
                    PromptKind::Approval => "; denying",
                    PromptKind::Ask => "",
                };
                self.sink.send_notification(
                    "cowork/log",
                    json!({
                        "type": "log",
                        "sessionId": self.thread_id,
                        "line": format!(
                            "[warn] {label} {request_id} timed out without a response{suffix}"
                        ),
                    }),
                );
                T::timed_out()
            }
        }
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

/// Outcome of a prompt nobody answered before the abandoned-prompt timeout.
trait TimedOutPrompt: Sized {
    fn timed_out() -> Result<Self, String>;
}

impl TimedOutPrompt for bool {
    /// Fail safe: an abandoned approval denies, never silently runs.
    fn timed_out() -> Result<Self, String> {
        Ok(false)
    }
}

impl TimedOutPrompt for String {
    fn timed_out() -> Result<Self, String> {
        Err(ASK_TIMEOUT_MESSAGE.to_owned())
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
        self.await_prompt(
            &request_id,
            PromptKind::Approval,
            rx,
            "Approval prompt cancelled.",
        )
        .await
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
        self.await_prompt(
            &request_id,
            PromptKind::Approval,
            rx,
            "File approval prompt cancelled.",
        )
        .await
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
        self.await_prompt(
            &request_id,
            PromptKind::Ask,
            rx,
            "User input prompt cancelled.",
        )
        .await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingSink {
        notifications: Mutex<Vec<(String, Value)>>,
        requests: Mutex<Vec<(String, String, Value)>>,
    }

    impl HarnessEventSink for RecordingSink {
        fn send_notification(&self, method: &str, params: Value) {
            self.notifications.lock().push((method.to_owned(), params));
        }
        fn send_server_request(&self, request_id: &str, method: &str, params: Value) {
            self.requests
                .lock()
                .push((request_id.to_owned(), method.to_owned(), params));
        }
    }

    impl RecordingSink {
        fn resolved_for(&self, request_id: &str) -> Vec<Value> {
            self.notifications
                .lock()
                .iter()
                .filter(|(m, p)| m == "serverRequest/resolved" && p["requestId"] == request_id)
                .map(|(_, p)| p.clone())
                .collect()
        }

        fn only_request_id(&self) -> String {
            let requests = self.requests.lock();
            assert_eq!(requests.len(), 1, "exactly one server request expected");
            requests[0].0.clone()
        }
    }

    const SHORT: Duration = Duration::from_millis(50);

    fn manager(timeout: Option<Duration>) -> (Arc<RecordingSink>, InteractionManager) {
        let sink = Arc::new(RecordingSink::default());
        let im = InteractionManager::new("thread-1", sink.clone() as Arc<dyn HarnessEventSink>)
            .with_turn_id("turn-1")
            .with_file_change_approval(true)
            .with_prompt_timeout(timeout);
        (sink, im)
    }

    fn command_request() -> ApprovalDecisionRequest {
        ApprovalDecisionRequest {
            command: "rm -rf build".to_owned(),
            reason: String::new(),
            detail: None,
            category: None,
            cwd: std::env::temp_dir(),
        }
    }

    #[test]
    fn default_prompt_timeout_matches_legacy_thirty_minutes() {
        assert_eq!(DEFAULT_PROMPT_TIMEOUT, Duration::from_secs(1800));
        let (_, im) = manager(Some(DEFAULT_PROMPT_TIMEOUT));
        assert_eq!(im.prompt_timeout, Some(DEFAULT_PROMPT_TIMEOUT));
        let im = InteractionManager::new("t", Arc::new(RecordingSink::default()));
        assert_eq!(im.prompt_timeout, Some(DEFAULT_PROMPT_TIMEOUT));
        let (_, im) = manager(Some(Duration::ZERO));
        assert_eq!(
            im.prompt_timeout, None,
            "a zero timeout disables the backstop"
        );
    }

    #[tokio::test]
    async fn abandoned_ask_times_out_rejects_and_broadcasts_resolution() {
        let (sink, im) = manager(Some(SHORT));
        let result = im.ask_user("Which branch?", None).await;
        assert_eq!(result, Err(ASK_TIMEOUT_MESSAGE.to_owned()));

        let request_id = sink.only_request_id();
        assert!(!im.has_pending_ask());
        assert!(!im.owns_request_id(&request_id));
        let resolved = sink.resolved_for(&request_id);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0]["threadId"], "thread-1");
        assert!(
            resolved[0].get("response").is_none(),
            "a timed-out ask carries no response (legacy parity)"
        );

        // A late answer after expiry is treated as unknown/expired.
        let late = im
            .resolve_client_response(&request_id, &json!({ "answer": "main" }))
            .expect_err("expired request");
        assert_eq!(late.code, error_codes::INVALID_REQUEST);
    }

    #[tokio::test]
    async fn abandoned_command_approval_times_out_as_denied() {
        let (sink, im) = manager(Some(SHORT));
        let result = im.approve_command(command_request()).await;
        assert_eq!(
            result,
            Ok(false),
            "an abandoned approval must deny, never run"
        );

        let request_id = sink.only_request_id();
        assert!(!im.has_pending_approval());
        let resolved = sink.resolved_for(&request_id);
        assert_eq!(resolved.len(), 1);
        assert_eq!(
            resolved[0]["response"],
            json!({ "kind": "approval", "approved": false })
        );
    }

    #[tokio::test]
    async fn abandoned_file_change_approval_times_out_as_denied() {
        let (sink, im) = manager(Some(SHORT));
        let result = im
            .approve_file_change(Path::new("/tmp/x.txt"), Some("edit"))
            .await;
        assert_eq!(result, Ok(false));

        let request_id = sink.only_request_id();
        assert!(!im.has_pending_approval());
        assert_eq!(
            sink.resolved_for(&request_id)[0]["response"],
            json!({ "kind": "approval", "approved": false })
        );
    }

    #[tokio::test]
    async fn answer_before_timeout_wins_and_timeout_does_not_fire() {
        let (sink, im) = manager(Some(Duration::from_millis(300)));
        let im = Arc::new(im);
        let waiter = {
            let im = Arc::clone(&im);
            tokio::spawn(async move { im.approve_command(command_request()).await })
        };
        let request_id = loop {
            if let Some(id) = sink.requests.lock().first().map(|r| r.0.clone()) {
                break id;
            }
            tokio::task::yield_now().await;
        };
        im.resolve_client_response(&request_id, &json!({ "decision": "accept" }))
            .expect("answer applied");
        assert_eq!(waiter.await.unwrap(), Ok(true));

        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            sink.resolved_for(&request_id).len(),
            1,
            "only the client's resolution is broadcast; no timeout fires afterwards"
        );
    }

    #[tokio::test]
    async fn disabled_timeout_keeps_waiting_for_an_answer() {
        let (sink, im) = manager(None);
        let im = Arc::new(im);
        let waiter = {
            let im = Arc::clone(&im);
            tokio::spawn(async move { im.ask_user("Continue?", None).await })
        };
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!waiter.is_finished());
        assert!(im.has_pending_ask());
        let request_id = sink.only_request_id();
        im.resolve_client_response(&request_id, &json!({ "answer": "yes" }))
            .expect("answer applied");
        assert_eq!(waiter.await.unwrap(), Ok("yes".to_owned()));
    }
}
