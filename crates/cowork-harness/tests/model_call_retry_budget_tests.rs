//! `modelSettings.maxRetries` / `AGENT_MODEL_MAX_RETRIES` is the number of model-call retries
//! after the initial attempt (TS `resolveRateLimitMaxAttempts`): the harness turns it into the
//! per-step attempt budget, clamped to the 4-attempt default, while the transport itself is
//! always asked for a single attempt so provider SDK retries never multiply that budget.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_harness::{
    HarnessEventSink, InteractionManager, SteerCoordinator, TurnRunConfig, TurnStepRunner,
};
use cowork_inference::{
    CanonicalMessage, ContentBlock, MessageRole, ProviderOpaqueMeta, ProviderTransportError,
    SessionCostTracker, StepBudget,
};
use cowork_providers::{
    ProviderStepRequest, ProviderStepResult, ProviderTransport, StreamEventCallback,
};
use cowork_tools::ToolExecutionContext;
use parking_lot::Mutex;
use serde_json::{Value, json};
use uuid::Uuid;

// bwrap re-executes the current binary as `__sandbox-exec --linux-seccomp`; dispatch it pre-libtest.
cowork_sandbox::install_sandbox_exec_test_hook!();

struct NullSink;

impl HarnessEventSink for NullSink {
    fn send_notification(&self, _method: &str, _params: Value) {}
    fn send_server_request(&self, _request_id: &str, _method: &str, _params: Value) {}
}

/// Fails every request with a retryable HTTP 503 before emitting any output.
#[derive(Default)]
struct AlwaysUnavailableTransport {
    requests: AtomicUsize,
    transport_attempt_budgets: Mutex<Vec<usize>>,
}

#[async_trait]
impl ProviderTransport for AlwaysUnavailableTransport {
    async fn stream_step(
        &self,
        req: ProviderStepRequest,
        _budget: &StepBudget,
        _on_event: &mut StreamEventCallback<'_>,
    ) -> Result<ProviderStepResult, ProviderTransportError> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.transport_attempt_budgets
            .lock()
            .push(req.policy.max_attempts);
        Err(ProviderTransportError::http(
            503,
            "service unavailable",
            HashMap::new(),
        ))
    }
}

struct TestDirs {
    root: PathBuf,
    home: PathBuf,
    ws: PathBuf,
}

impl TestDirs {
    fn new() -> Self {
        let base = if cfg!(target_os = "macos") {
            PathBuf::from("/private/tmp")
        } else {
            std::env::temp_dir()
        };
        let root = base.join(format!("cowork-harness-retry-budget-{}", Uuid::new_v4()));
        let home = root.join("home");
        let ws = root.join("workspace");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&ws).unwrap();
        Self {
            root: fs::canonicalize(&root).unwrap(),
            home: fs::canonicalize(home).unwrap(),
            ws: fs::canonicalize(ws).unwrap(),
        }
    }
}

impl Drop for TestDirs {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Runs one turn against an always-503 provider and returns the number of model requests made.
async fn requests_for(model_max_retries: Option<u32>) -> usize {
    let dirs = TestDirs::new();
    let sink: Arc<dyn HarnessEventSink> = Arc::new(NullSink);
    let interactions = Arc::new(InteractionManager::new("thread-1", sink.clone()));
    let steer = Arc::new(SteerCoordinator::new(
        "thread-1",
        "turn-1",
        sink.clone(),
        None,
    ));
    let mut tool_ctx = ToolExecutionContext::new_for_tests(
        dirs.home.clone(),
        dirs.ws.clone(),
        ProviderName::Openai,
        "gpt-5.4",
    );
    tool_ctx.approval_handler = Some(interactions.clone());
    let mut cost_tracker = SessionCostTracker::new("thread-1", None);

    // `maxRetryDelayMs: 0` collapses the backoff so the default 4-attempt budget runs instantly.
    let provider_options = json!({ "openai": { "maxRetryDelayMs": 0 } })
        .as_object()
        .cloned()
        .unwrap();
    let runner = TurnStepRunner::new(TurnRunConfig {
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        provider: ProviderName::Openai,
        model_id: "gpt-5.4".to_owned(),
        base_url: None,
        api_key: Some("test-key".to_owned()),
        extra_headers: HashMap::new(),
        system_prompt: "Test system prompt".to_owned(),
        provider_options,
        deferred_tool_search: false,
        max_steps: 5,
        step_timeout_ms: 30_000,
        overflow_threshold_chars: None,
        tool_retry_lineage: false,
        initial_user_message: None,
        model_max_retries,
    });
    let transport = Arc::new(AlwaysUnavailableTransport::default());
    let initial = vec![CanonicalMessage {
        id: "u1".to_owned(),
        role: MessageRole::User,
        content: vec![ContentBlock::Text {
            text: "hello".to_owned(),
            phase: None,
            citations: Vec::new(),
            provider_meta: ProviderOpaqueMeta::default(),
        }],
        phase: None,
        provider: None,
        api: None,
        model: None,
        stop_reason: None,
        provider_meta: ProviderOpaqueMeta::default(),
        created_at: "2026-10-30T12:00:00Z".to_owned(),
    }];

    let outcome = runner
        .run_turn(
            transport.clone(),
            initial,
            &mut tool_ctx,
            &interactions,
            &steer,
            &mut cost_tracker,
            None,
            sink,
        )
        .await;
    assert_eq!(outcome.status, "failed");
    assert!(
        transport
            .transport_attempt_budgets
            .lock()
            .iter()
            .all(|&n| n == 1),
        "transport-level (SDK) retries must stay disabled"
    );
    transport.requests.load(Ordering::SeqCst)
}

#[tokio::test]
async fn zero_max_retries_makes_exactly_one_model_request() {
    assert_eq!(requests_for(Some(0)).await, 1);
}

#[tokio::test]
async fn one_max_retry_makes_exactly_two_model_requests() {
    assert_eq!(requests_for(Some(1)).await, 2);
}

#[tokio::test]
async fn unset_max_retries_keeps_the_default_four_attempts() {
    assert_eq!(requests_for(None).await, 4);
}

#[tokio::test]
async fn max_retries_above_the_default_budget_is_clamped_to_four_attempts() {
    assert_eq!(requests_for(Some(10)).await, 4);
}
