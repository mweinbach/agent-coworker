//! Reply parsing for server-initiated approval / user-input requests (legacy
//! `transportAdapter.ts` parity): any denial signal rejects an approval, and ask replies may
//! arrive as text content parts.

use std::sync::Arc;

use cowork_harness::{HarnessEventSink, InteractionManager};
use cowork_tools::{ApprovalDecisionRequest, ApprovalHandler};
use parking_lot::Mutex;
use serde_json::{Value, json};

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

fn manager() -> (Arc<RecordingSink>, Arc<InteractionManager>) {
    let sink = Arc::new(RecordingSink::default());
    let im = InteractionManager::new("thread-1", sink.clone() as Arc<dyn HarnessEventSink>)
        .with_turn_id("turn-1")
        .with_prompt_timeout(None);
    (sink, Arc::new(im))
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

async fn next_request_id(sink: &RecordingSink, seen: usize) -> String {
    loop {
        if let Some(id) = sink.requests.lock().get(seen).map(|r| r.0.clone()) {
            return id;
        }
        tokio::task::yield_now().await;
    }
}

async fn approval_outcome(reply: Value) -> Result<bool, String> {
    let (sink, im) = manager();
    let waiter = {
        let im = Arc::clone(&im);
        tokio::spawn(async move { im.approve_command(command_request()).await })
    };
    let request_id = next_request_id(&sink, 0).await;
    let resolved = im
        .resolve_client_response(&request_id, &reply)
        .unwrap_or_else(|e| panic!("reply {reply} must be accepted: {e:?}"));
    let outcome = waiter.await.unwrap();
    assert_eq!(
        resolved["response"],
        json!({ "kind": "approval", "approved": outcome.clone().unwrap() })
    );
    outcome
}

#[tokio::test]
async fn explicit_decline_overrides_approved_true() {
    for decision in ["decline", "reject"] {
        assert_eq!(
            approval_outcome(json!({ "approved": true, "decision": decision })).await,
            Ok(false),
            "approved:true + decision:{decision} must deny"
        );
    }
}

#[tokio::test]
async fn approved_false_overrides_accepting_decision() {
    for decision in ["accept", "acceptForSession"] {
        assert_eq!(
            approval_outcome(json!({ "approved": false, "decision": decision })).await,
            Ok(false),
            "approved:false + decision:{decision} must deny"
        );
    }
}

#[tokio::test]
async fn consistent_approval_signals_still_approve() {
    assert_eq!(
        approval_outcome(json!({ "approved": true })).await,
        Ok(true)
    );
    assert_eq!(
        approval_outcome(json!({ "decision": "accept" })).await,
        Ok(true)
    );
    assert_eq!(
        approval_outcome(json!({ "approved": true, "decision": "acceptForSession" })).await,
        Ok(true)
    );
    assert_eq!(
        approval_outcome(json!({ "decision": "decline" })).await,
        Ok(false)
    );
}

#[tokio::test]
async fn unrecognized_decision_with_approved_true_is_invalid_and_stays_pending() {
    let (sink, im) = manager();
    let waiter = {
        let im = Arc::clone(&im);
        tokio::spawn(async move { im.approve_command(command_request()).await })
    };
    let request_id = next_request_id(&sink, 0).await;
    let err = im
        .resolve_client_response(
            &request_id,
            &json!({ "approved": true, "decision": "maybe" }),
        )
        .expect_err("unknown decision is invalid");
    assert_eq!(err.code, cowork_protocol::error_codes::INVALID_PARAMS);
    assert!(
        im.has_pending_approval(),
        "prompt stays pending for a retry"
    );
    im.resolve_client_response(&request_id, &json!({ "decision": "decline" }))
        .expect("retry applied");
    assert_eq!(waiter.await.unwrap(), Ok(false));
}

#[tokio::test]
async fn ask_accepts_text_content_parts() {
    let (sink, im) = manager();
    let waiter = {
        let im = Arc::clone(&im);
        tokio::spawn(async move { im.ask_user("Ship it?", None).await })
    };
    let request_id = next_request_id(&sink, 0).await;
    let resolved = im
        .resolve_client_response(
            &request_id,
            &json!({ "content": [{ "type": "text", "text": "Looks good" }] }),
        )
        .expect("content-part reply accepted");
    assert_eq!(waiter.await.unwrap(), Ok("Looks good".to_owned()));
    assert_eq!(
        resolved["response"],
        json!({ "kind": "ask", "answer": "Looks good" })
    );

    // An identical duplicate is idempotent.
    let dup = im
        .resolve_client_response(
            &request_id,
            &json!({ "content": [{ "type": "text", "text": "Looks good" }] }),
        )
        .expect("duplicate is already_applied");
    assert_eq!(dup["status"], "already_applied");
}

#[tokio::test]
async fn ask_joins_multiple_text_parts_and_ignores_non_text_parts() {
    let (sink, im) = manager();
    let waiter = {
        let im = Arc::clone(&im);
        tokio::spawn(async move { im.ask_user("Details?", None).await })
    };
    let request_id = next_request_id(&sink, 0).await;
    im.resolve_client_response(
        &request_id,
        &json!({ "content": [
            { "type": "text", "text": "first" },
            { "type": "image", "url": "x" },
            { "type": "inputText", "text": "second " }
        ] }),
    )
    .expect("reply accepted");
    assert_eq!(waiter.await.unwrap(), Ok("first\nsecond".to_owned()));
}

#[tokio::test]
async fn ask_with_empty_text_content_is_rejected_and_re_emitted() {
    let (sink, im) = manager();
    let waiter = {
        let im = Arc::clone(&im);
        tokio::spawn(async move { im.ask_user("Name?", None).await })
    };
    let request_id = next_request_id(&sink, 0).await;
    let err = im
        .resolve_client_response(
            &request_id,
            &json!({ "content": [{ "type": "text", "text": "   " }] }),
        )
        .expect_err("whitespace-only content is empty");
    assert_eq!(err.code, cowork_protocol::error_codes::INVALID_PARAMS);
    assert!(im.has_pending_ask());
    assert_eq!(
        next_request_id(&sink, 1).await,
        request_id,
        "prompt re-emitted"
    );

    im.resolve_client_response(&request_id, &json!({ "answer": "Ada" }))
        .expect("retry applied");
    assert_eq!(waiter.await.unwrap(), Ok("Ada".to_owned()));
}

#[tokio::test]
async fn ask_answer_and_skipped_forms_still_work() {
    let (sink, im) = manager();
    let waiter = {
        let im = Arc::clone(&im);
        tokio::spawn(async move { im.ask_user("Q?", None).await })
    };
    let request_id = next_request_id(&sink, 0).await;
    im.resolve_client_response(&request_id, &json!({ "skipped": true }))
        .expect("skip applied");
    assert_eq!(
        waiter.await.unwrap(),
        Ok(cowork_tools::ASK_SKIP_TOKEN.to_owned())
    );
}
