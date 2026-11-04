//! Stop must be honoured between tool calls in a batch (TS `wrapToolWithMutationGate` calls
//! `signal?.throwIfAborted()` before every tool). Many tools never poll cancellation themselves,
//! so `execute_tool_batch` has to refuse to start later calls once the turn is cancelled, while
//! still answering every call so the transcript stays consistent.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use cowork_config::ProviderName;
use cowork_tools::catalog::TOOL_CALL_ABORTED_MESSAGE;
use cowork_tools::{
    BuiltinTool, DeferredToolCatalog, ToolBatchCall, ToolExecutionContext, ToolExecutionPolicy,
    ToolMap, ToolOutput, ToolResult, execute_tool_batch,
};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

/// Non-cooperative slow tool: never polls cancellation, just takes a while.
struct SlowTool {
    runs: Arc<AtomicUsize>,
}

#[async_trait]
impl BuiltinTool for SlowTool {
    fn name(&self) -> &str {
        "slow"
    }
    fn description(&self) -> &str {
        "slow"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object" })
    }
    async fn execute(
        &self,
        _raw_args: Map<String, Value>,
        _ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(150)).await;
        Ok(ToolOutput::Text("slow done".to_owned()))
    }
}

/// Side-effecting tool that never checks cancellation (like spawnAgent / manageMemory).
struct EffectTool {
    name: &'static str,
    policy: ToolExecutionPolicy,
    runs: Arc<AtomicUsize>,
}

#[async_trait]
impl BuiltinTool for EffectTool {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "effect"
    }
    fn input_schema(&self) -> Value {
        json!({ "type": "object" })
    }
    fn execution_policy(&self) -> ToolExecutionPolicy {
        self.policy
    }
    async fn execute(
        &self,
        _raw_args: Map<String, Value>,
        _ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok(ToolOutput::Text("effect done".to_owned()))
    }
}

struct Fixture {
    _tmp: tempfile::TempDir,
    ctx: ToolExecutionContext,
    cancel_tx: watch::Sender<bool>,
    tools: ToolMap,
    slow_runs: Arc<AtomicUsize>,
    effect_runs: Arc<AtomicUsize>,
    read_runs: Arc<AtomicUsize>,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let ws = tmp.path().join("ws");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();
    let mut ctx = ToolExecutionContext::new_for_tests(
        canon(&home),
        canon(&ws),
        ProviderName::Openai,
        "gpt-5.4",
    );
    let (cancel_tx, cancel_rx) = watch::channel(false);
    ctx.cancel_rx = Some(cancel_rx);

    let slow_runs = Arc::new(AtomicUsize::new(0));
    let effect_runs = Arc::new(AtomicUsize::new(0));
    let read_runs = Arc::new(AtomicUsize::new(0));
    let mut tools: ToolMap = BTreeMap::new();
    tools.insert(
        "slow".to_owned(),
        Arc::new(SlowTool {
            runs: slow_runs.clone(),
        }),
    );
    tools.insert(
        "effect".to_owned(),
        Arc::new(EffectTool {
            name: "effect",
            policy: ToolExecutionPolicy::Sequential,
            runs: effect_runs.clone(),
        }),
    );
    tools.insert(
        "parallelRead".to_owned(),
        Arc::new(EffectTool {
            name: "parallelRead",
            policy: ToolExecutionPolicy::ParallelRead,
            runs: read_runs.clone(),
        }),
    );
    Fixture {
        _tmp: tmp,
        ctx,
        cancel_tx,
        tools,
        slow_runs,
        effect_runs,
        read_runs,
    }
}

fn canon(p: &Path) -> std::path::PathBuf {
    fs::canonicalize(p).unwrap()
}

fn call(id: &str, tool: &str) -> ToolBatchCall {
    ToolBatchCall {
        call_id: id.to_owned(),
        tool_name: tool.to_owned(),
        arguments: Map::new(),
    }
}

fn fire_cancel_soon(tx: watch::Sender<bool>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(30)).await;
        let _ = tx.send(true);
        // Keep the sender alive so receivers keep observing `true`.
        tokio::time::sleep(Duration::from_millis(500)).await;
    })
}

#[tokio::test]
async fn stop_during_slow_tool_skips_later_side_effect_tool() {
    let f = fixture();
    let canceller = fire_cancel_soon(f.cancel_tx.clone());
    let calls = vec![call("c1", "slow"), call("c2", "effect")];

    let results = execute_tool_batch(&f.tools, &calls, &f.ctx, None).await;
    canceller.abort();

    assert_eq!(f.slow_runs.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.effect_runs.load(Ordering::SeqCst),
        0,
        "side-effect tool must not start after Stop"
    );
    // Every tool_use still gets a tool_result, in request order.
    assert_eq!(
        results
            .iter()
            .map(|r| r.call_id.as_str())
            .collect::<Vec<_>>(),
        ["c1", "c2"]
    );
    assert!(results[0].output.is_ok(), "already-running call completes");
    assert_eq!(results[1].tool_name, "effect");
    assert_eq!(
        results[1].output.as_ref().unwrap_err().to_string(),
        TOOL_CALL_ABORTED_MESSAGE
    );
}

#[tokio::test]
async fn stop_during_slow_tool_skips_following_parallel_read_run() {
    let f = fixture();
    let canceller = fire_cancel_soon(f.cancel_tx.clone());
    let calls = vec![
        call("c1", "slow"),
        call("c2", "parallelRead"),
        call("c3", "parallelRead"),
        call("c4", "effect"),
    ];

    let results = execute_tool_batch(&f.tools, &calls, &f.ctx, None).await;
    canceller.abort();

    assert_eq!(f.read_runs.load(Ordering::SeqCst), 0);
    assert_eq!(f.effect_runs.load(Ordering::SeqCst), 0);
    assert_eq!(results.len(), 4);
    for r in &results[1..] {
        assert_eq!(
            r.output.as_ref().unwrap_err().to_string(),
            TOOL_CALL_ABORTED_MESSAGE,
            "{} must get the aborted result",
            r.call_id
        );
    }
}

#[tokio::test]
async fn already_cancelled_batch_runs_nothing_but_answers_every_call() {
    let f = fixture();
    f.cancel_tx.send(true).unwrap();
    let calls = vec![
        call("c1", "parallelRead"),
        call("c2", "effect"),
        call("c3", "missingTool"),
    ];

    let results = execute_tool_batch(&f.tools, &calls, &f.ctx, None).await;

    assert_eq!(f.read_runs.load(Ordering::SeqCst), 0);
    assert_eq!(f.effect_runs.load(Ordering::SeqCst), 0);
    assert_eq!(f.slow_runs.load(Ordering::SeqCst), 0);
    assert_eq!(
        results
            .iter()
            .map(|r| r.call_id.as_str())
            .collect::<Vec<_>>(),
        ["c1", "c2", "c3"]
    );
    for r in &results {
        assert_eq!(
            r.output.as_ref().unwrap_err().to_string(),
            TOOL_CALL_ABORTED_MESSAGE
        );
    }
}

#[tokio::test]
async fn uncancelled_batch_runs_every_call() {
    let f = fixture();
    let calls = vec![
        call("c1", "effect"),
        call("c2", "parallelRead"),
        call("c3", "parallelRead"),
    ];
    let results = execute_tool_batch(&f.tools, &calls, &f.ctx, None).await;
    assert!(results.iter().all(|r| r.output.is_ok()));
    assert_eq!(f.effect_runs.load(Ordering::SeqCst), 1);
    assert_eq!(f.read_runs.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn deferred_tool_call_refuses_to_start_after_stop() {
    let f = fixture();
    let catalog = DeferredToolCatalog::new(f.tools.clone());
    f.cancel_tx.send(true).unwrap();
    let args: Map<String, Value> =
        serde_json::from_value(json!({ "name": "effect", "arguments": {} })).unwrap();
    let err = catalog.execute_tool_call(&args, &f.ctx).await.unwrap_err();
    assert_eq!(err.to_string(), TOOL_CALL_ABORTED_MESSAGE);
    assert_eq!(f.effect_runs.load(Ordering::SeqCst), 0);
}
