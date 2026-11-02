//! Failed workflow runs must cancel outstanding host agent calls before awaiting cleanup,
//! instead of waiting for each agent's own deadline.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cowork_js_vm::{
    VmError, WorkflowAgentBridgeReply, WorkflowCompileResult, WorkflowMeta, WorkflowVmBridge,
    WorkflowVmRunOptions, compile_workflow_source, execute_workflow_module,
    inspect_workflow_source,
};
use serde_json::Value;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// Stand-in for an agent's own deadline (the real default is ten minutes). A run that waits
/// this long for cleanup has not cancelled its outstanding agents.
const HANGING_AGENT_DEADLINE: Duration = Duration::from_secs(30);
/// Upper bound for a failed run to return once its outstanding agents are cancelled.
const PROMPT_RETURN_BOUND: Duration = Duration::from_secs(10);

#[derive(Default)]
struct HangingAgentBridge {
    hang_started: Notify,
    hang_saw_cancel: AtomicBool,
    hang_finished: AtomicBool,
}

impl HangingAgentBridge {
    fn reply(ok: bool, message: &str) -> WorkflowAgentBridgeReply {
        WorkflowAgentBridgeReply {
            ok,
            value: None,
            message: Some(message.to_owned()),
            spent_usd: 0.0,
            fatal: false,
        }
    }
}

#[async_trait]
impl WorkflowVmBridge for HangingAgentBridge {
    async fn on_meta(&self, _meta: WorkflowMeta) -> Result<(), String> {
        Ok(())
    }

    async fn on_phase(&self, _title: String) -> Result<(), String> {
        Ok(())
    }

    async fn on_log(&self, _message: String) {}

    async fn run_agent(
        &self,
        raw_payload: String,
        cancel: CancellationToken,
    ) -> WorkflowAgentBridgeReply {
        let payload: Value = serde_json::from_str(&raw_payload).expect("agent payload is JSON");
        match payload.get("prompt").and_then(Value::as_str) {
            Some("hang") => {
                self.hang_started.notify_one();
                // Never completes on its own before the deadline; only cancellation ends it.
                let reply = tokio::select! {
                    () = cancel.cancelled() => {
                        self.hang_saw_cancel.store(true, Ordering::SeqCst);
                        Self::reply(false, "agent cancelled")
                    }
                    () = tokio::time::sleep(HANGING_AGENT_DEADLINE) => {
                        Self::reply(false, "agent deadline elapsed")
                    }
                };
                self.hang_finished.store(true, Ordering::SeqCst);
                reply
            }
            Some("fail") => {
                // Fail only once the hanging agent is in flight, so the run errors while it
                // is still outstanding.
                self.hang_started.notified().await;
                Self::reply(false, "boom from failing agent")
            }
            other => panic!("unexpected agent prompt: {other:?}"),
        }
    }
}

fn compile(source: &str) -> String {
    match compile_workflow_source(source) {
        WorkflowCompileResult::Ok { js, .. } => js,
        WorkflowCompileResult::Err { issues } => panic!("workflow failed to compile: {issues:?}"),
    }
}

async fn run_with_timeout(
    source: &str,
    run_timeout_ms: u64,
    bridge: Arc<HangingAgentBridge>,
) -> (Result<Value, VmError>, Duration) {
    run_with_options(source, run_timeout_ms, None, bridge).await
}

async fn run_with_options(
    source: &str,
    run_timeout_ms: u64,
    cancel_token: Option<CancellationToken>,
    bridge: Arc<HangingAgentBridge>,
) -> (Result<Value, VmError>, Duration) {
    let opts = WorkflowVmRunOptions {
        js: compile(source),
        args_json: "{}".to_owned(),
        budget_total: None,
        run_timeout_ms,
        max_memory_bytes: 32 * 1024 * 1024,
        cancel_token,
    };
    let started = Instant::now();
    let res = tokio::time::timeout(
        PROMPT_RETURN_BOUND,
        execute_workflow_module(opts, bridge as Arc<dyn WorkflowVmBridge>),
    )
    .await
    .expect("failed workflow run must return promptly instead of waiting on its agents");
    (res, started.elapsed())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workflow_timeout_cancels_outstanding_agent_before_cleanup() {
    let source = r#"
        export const meta = { name: "hang", description: "awaits a hanging agent", phases: ["one"] };
        export default async function run(host) {
            await host.agent("hang");
            return "unreachable";
        }
    "#;
    let bridge = Arc::new(HangingAgentBridge::default());

    let (res, elapsed) = run_with_timeout(source, 300, Arc::clone(&bridge)).await;

    assert!(
        matches!(res, Err(VmError::TimedOut { .. })),
        "expected TimedOut, got {res:?}"
    );
    assert!(
        elapsed < PROMPT_RETURN_BOUND,
        "timed-out run took {elapsed:?}"
    );
    assert!(
        bridge.hang_saw_cancel.load(Ordering::SeqCst),
        "outstanding agent call must observe cancellation"
    );
    assert!(
        bridge.hang_finished.load(Ordering::SeqCst),
        "outstanding agent call must be joined before the run returns"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workflow_execution_error_cancels_outstanding_agent_before_cleanup() {
    let source = r#"
        export const meta = { name: "boom", description: "fails while an agent hangs", phases: ["one"] };
        export default async function run(host) {
            await Promise.all([host.agent("hang"), host.agent("fail")]);
            return "unreachable";
        }
    "#;
    let bridge = Arc::new(HangingAgentBridge::default());

    // Run timeout far beyond the failure point, so only the execution error ends the run.
    let (res, elapsed) = run_with_timeout(source, 60_000, Arc::clone(&bridge)).await;

    match &res {
        Err(VmError::Execution(msg)) => assert!(
            msg.contains("boom from failing agent"),
            "unexpected execution error: {msg}"
        ),
        other => panic!("expected an execution error, got {other:?}"),
    }
    assert!(elapsed < PROMPT_RETURN_BOUND, "failed run took {elapsed:?}");
    assert!(
        bridge.hang_saw_cancel.load(Ordering::SeqCst),
        "outstanding agent call must observe cancellation"
    );
    assert!(
        bridge.hang_finished.load(Ordering::SeqCst),
        "outstanding agent call must be joined before the run returns"
    );
}

/// A valid workflow whose module initialisation never settles. QuickJS has no JavaScript left to
/// run, so the isolate's interrupt handler never fires; only the host-side deadline can end it.
const PENDING_TOP_LEVEL_AWAIT: &str = r#"
    await new Promise(() => {});
    export const meta = { name: "stuck", description: "never finishes module init", phases: ["one"] };
    export default async function run() {
        return "unreachable";
    }
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inspection_times_out_on_pending_top_level_await() {
    let started = Instant::now();
    let res = tokio::time::timeout(
        PROMPT_RETURN_BOUND,
        inspect_workflow_source(PENDING_TOP_LEVEL_AWAIT, 300),
    )
    .await
    .expect("metadata inspection must honour its deadline during module evaluation");
    let elapsed = started.elapsed();

    let issues = res.expect_err("pending module init must fail inspection");
    assert_eq!(issues.len(), 1, "unexpected issues: {issues:?}");
    assert_eq!(issues[0].path, "script");
    assert_eq!(
        issues[0].message,
        "workflow metadata inspection exceeded 300ms"
    );
    assert!(
        elapsed >= Duration::from_millis(250),
        "inspection returned before its deadline: {elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn run_timeout_applies_to_pending_module_init() {
    let bridge = Arc::new(HangingAgentBridge::default());

    let (res, elapsed) = run_with_timeout(PENDING_TOP_LEVEL_AWAIT, 300, bridge).await;

    assert!(
        matches!(res, Err(VmError::TimedOut { timeout_ms: 300 })),
        "expected TimedOut, got {res:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(250),
        "run returned before its deadline: {elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_interrupts_pending_module_init() {
    let bridge = Arc::new(HangingAgentBridge::default());
    let cancel = CancellationToken::new();
    let trigger = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        trigger.cancel();
    });

    // Run timeout far beyond the cancellation point, so only Stop ends the run.
    let (res, elapsed) =
        run_with_options(PENDING_TOP_LEVEL_AWAIT, 60_000, Some(cancel), bridge).await;

    assert!(
        matches!(res, Err(VmError::Cancelled)),
        "expected Cancelled, got {res:?}"
    );
    assert!(
        elapsed < PROMPT_RETURN_BOUND,
        "cancelled run took {elapsed:?}"
    );
}
