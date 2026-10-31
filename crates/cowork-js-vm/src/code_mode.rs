use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use rquickjs::prelude::*;
use rquickjs::{AsyncContext, Function, Module, Promise};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::realm::{
    DEFAULT_MAX_CONSOLE_LINE_CHARS, DEFAULT_MAX_CONSOLE_LOGS, DEFAULT_WALL_CLOCK_TIMEOUT_MS,
    DeterminismMode, InterruptCause, IsolateLimits, VmError, create_isolated_runtime,
    extract_caught_error, install_realm_seal,
};
use crate::transpile::compile_code_mode_module;
use crate::{DEFAULT_ISOLATE_HEAP_LIMIT_BYTES, DEFAULT_ISOLATE_MAX_STACK_BYTES};

pub const RESERVED_CODE_MODE_TOOL_NAMES: &[&str] =
    &["toolSearch", "toolCall", "codeMode", "prototype"];

#[async_trait]
pub trait CodeModeCatalog: Send + Sync {
    async fn search(&self, query: &str, cancel: CancellationToken) -> Result<Value, String>;
    async fn call(
        &self,
        name: &str,
        arguments: Value,
        cancel: CancellationToken,
    ) -> Result<Value, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeModeLimits {
    pub timeout_ms: u64,
    pub max_source_bytes: usize,
    pub max_argument_bytes: usize,
    pub max_output_bytes: usize,
    pub max_memory_bytes: usize,
    pub max_stack_bytes: usize,
    pub max_transport_bytes: usize,
    pub max_calls: usize,
    pub max_concurrency: usize,
    pub max_console_logs: usize,
    pub max_console_line_chars: usize,
    pub freeze_intrinsics: bool,
}

impl Default for CodeModeLimits {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
            max_source_bytes: 64 * 1024,
            max_argument_bytes: 64 * 1024,
            max_output_bytes: 1024 * 1024,
            max_memory_bytes: DEFAULT_ISOLATE_HEAP_LIMIT_BYTES,
            max_stack_bytes: DEFAULT_ISOLATE_MAX_STACK_BYTES,
            max_transport_bytes: 16 * 1024 * 1024,
            max_calls: 64,
            max_concurrency: 4,
            max_console_logs: DEFAULT_MAX_CONSOLE_LOGS,
            max_console_line_chars: DEFAULT_MAX_CONSOLE_LINE_CHARS,
            freeze_intrinsics: true,
        }
    }
}

impl CodeModeLimits {
    pub fn validate(&self) -> Result<(), VmError> {
        if self.timeout_ms == 0 || self.timeout_ms > 30_000 {
            return Err(VmError::Execution(
                "code mode timeoutMs must be between 1 and 30000".to_owned(),
            ));
        }
        if self.max_source_bytes == 0 || self.max_source_bytes > 256 * 1024 {
            return Err(VmError::Execution(
                "code mode maxSourceBytes must be between 1 and 262144".to_owned(),
            ));
        }
        if self.max_argument_bytes == 0 || self.max_argument_bytes > 256 * 1024 {
            return Err(VmError::Execution(
                "code mode maxArgumentBytes must be between 1 and 262144".to_owned(),
            ));
        }
        if self.max_output_bytes == 0 || self.max_output_bytes > 8 * 1024 * 1024 {
            return Err(VmError::Execution(
                "code mode maxOutputBytes must be between 1 and 8388608".to_owned(),
            ));
        }
        if self.max_memory_bytes == 0 || self.max_memory_bytes > 1024 * 1024 * 1024 {
            return Err(VmError::Execution(
                "code mode maxMemoryBytes must be between 1 and 1073741824".to_owned(),
            ));
        }
        if self.max_transport_bytes == 0 || self.max_transport_bytes > 64 * 1024 * 1024 {
            return Err(VmError::Execution(
                "code mode maxTransportBytes must be between 1 and 67108864".to_owned(),
            ));
        }
        if self.max_calls == 0 || self.max_calls > 1_024 {
            return Err(VmError::Execution(
                "code mode maxCalls must be between 1 and 1024".to_owned(),
            ));
        }
        if self.max_concurrency == 0 || self.max_concurrency > 32 {
            return Err(VmError::Execution(
                "code mode maxConcurrency must be between 1 and 32".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum CodeModeCallEvent {
    Start {
        execution_id: String,
        call_id: String,
        operation: String,
        name: String,
        input: Value,
    },
    End {
        execution_id: String,
        call_id: String,
        operation: String,
        name: String,
        status: String,
        duration_ms: u64,
        output: Option<Value>,
        error: Option<String>,
    },
}

pub type CodeModeCallEventSink = Arc<dyn Fn(CodeModeCallEvent) + Send + Sync>;

#[derive(Clone, Default)]
pub struct CodeModeOptions {
    pub limits: CodeModeLimits,
    pub cancel_token: Option<CancellationToken>,
    pub on_call_event: Option<CodeModeCallEventSink>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeModeExecutionResult {
    pub value: Value,
    pub logs: Vec<String>,
    pub logs_truncated: bool,
    pub call_count: usize,
}

struct BridgeRequest {
    operation: String,
    payload: String,
    reply_tx: oneshot::Sender<String>,
}

/// Strips TypeScript via `oxc` (`SemanticBuilder` + `Transformer`), executes the `codeMode`
/// async body in an isolated `rquickjs` runtime with byte heap caps, wall-clock interrupt
/// enforcement, frozen intrinsics, and bounded `tools.search` / `tools.call` RPCs.
pub async fn execute_code_mode(
    code: &str,
    catalog: Arc<dyn CodeModeCatalog>,
    options: CodeModeOptions,
) -> Result<CodeModeExecutionResult, VmError> {
    options.limits.validate()?;
    if code.is_empty() {
        return Err(VmError::Execution("code must not be empty".to_owned()));
    }
    if code.len() > options.limits.max_source_bytes {
        return Err(VmError::Execution(
            "code mode source exceeds maxSourceBytes".to_owned(),
        ));
    }
    if options
        .cancel_token
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return Err(VmError::Cancelled);
    }

    let compiled_js = compile_code_mode_module(code).map_err(VmError::Execution)?;

    let execution_id = Uuid::new_v4().to_string();
    let run_cancel = CancellationToken::new();
    if let Some(parent_cancel) = options.cancel_token.clone() {
        let child_cancel = run_cancel.clone();
        tokio::spawn(async move {
            parent_cancel.cancelled().await;
            child_cancel.cancel();
        });
    }

    let (req_tx, mut req_rx) = mpsc::unbounded_channel::<BridgeRequest>();
    let semaphore = Arc::new(Semaphore::new(options.limits.max_concurrency));
    let transport_bytes = Arc::new(AtomicUsize::new(0));
    let budget_exceeded_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Host-side dispatcher running on the caller's Tokio runtime with bounded concurrency
    let limits_for_host = options.limits.clone();
    let cancel_for_host = run_cancel.clone();
    let on_event = options.on_call_event.clone();
    let transport_for_host = Arc::clone(&transport_bytes);
    let budget_err_for_host = Arc::clone(&budget_exceeded_error);
    let exec_id_for_host = execution_id.clone();

    let dispatcher_handle = tokio::spawn(async move {
        let mut inflight = Vec::new();
        while let Some(req) = req_rx.recv().await {
            let total_in = transport_for_host
                .fetch_add(req.payload.len(), Ordering::SeqCst)
                .saturating_add(req.payload.len());
            if total_in > limits_for_host.max_transport_bytes {
                let msg = "code mode exceeded maxTransportBytes".to_owned();
                *budget_err_for_host.lock() = Some(msg.clone());
                cancel_for_host.cancel();
                let _ = req
                    .reply_tx
                    .send(json!({ "ok": false, "message": msg }).to_string());
                continue;
            }

            let sem = Arc::clone(&semaphore);
            let cat = Arc::clone(&catalog);
            let call_cancel = cancel_for_host.child_token();
            let event_sink = on_event.clone();
            let limits = limits_for_host.clone();
            let transport_acc = Arc::clone(&transport_for_host);
            let budget_err = Arc::clone(&budget_err_for_host);
            let parent_cancel = cancel_for_host.clone();
            let exec_id = exec_id_for_host.clone();

            let task = tokio::spawn(async move {
                let permit = tokio::select! {
                    p = sem.acquire_owned() => match p {
                        Ok(p) => p,
                        Err(_) => return,
                    },
                    _ = call_cancel.cancelled() => {
                        let _ = req.reply_tx.send(
                            json!({ "ok": false, "message": "code mode cancelled" }).to_string(),
                        );
                        return;
                    }
                };

                let parsed_in: Value = match serde_json::from_str(&req.payload) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = req.reply_tx.send(
                            json!({ "ok": false, "message": format!("invalid tool input JSON: {e}") })
                                .to_string(),
                        );
                        drop(permit);
                        return;
                    }
                };

                let call_id = Uuid::new_v4().to_string();
                let tool_name = if req.operation == "search" {
                    "toolSearch".to_owned()
                } else {
                    parsed_in
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned()
                };

                if let Some(ref sink) = event_sink {
                    sink(CodeModeCallEvent::Start {
                        execution_id: exec_id.clone(),
                        call_id: call_id.clone(),
                        operation: req.operation.clone(),
                        name: tool_name.clone(),
                        input: parsed_in.clone(),
                    });
                }

                let started = Instant::now();
                let call_res = if req.operation == "search" {
                    match parsed_in.get("query").and_then(Value::as_str) {
                        Some(q) => cat.search(q, call_cancel.clone()).await,
                        None => Err("tools.search requires a string query".to_owned()),
                    }
                } else if req.operation == "call" {
                    match parsed_in.get("name").and_then(Value::as_str) {
                        Some(name) if RESERVED_CODE_MODE_TOOL_NAMES.contains(&name) => {
                            // Still forward to catalog in case custom catalog handles/logs it,
                            // or reject directly if needed — let catalog decide or enforce if not overridden:
                            cat.call(
                                name,
                                parsed_in.get("arguments").cloned().unwrap_or(Value::Null),
                                call_cancel.clone(),
                            )
                            .await
                        }
                        Some(name) => {
                            cat.call(
                                name,
                                parsed_in.get("arguments").cloned().unwrap_or(Value::Null),
                                call_cancel.clone(),
                            )
                            .await
                        }
                        None => Err("tools.call requires a string tool name".to_owned()),
                    }
                } else {
                    Err("invalid operation".to_owned())
                };
                drop(permit);

                let duration_ms = started.elapsed().as_millis() as u64;
                let response_str = match call_res {
                    Ok(val) => {
                        let ok_envelope = json!({ "ok": true, "value": val });
                        let serialized = serde_json::to_string(&ok_envelope).unwrap_or_else(|_| {
                            "{\"ok\":false,\"message\":\"tool output must be JSON\"}".to_owned()
                        });
                        // Check output size of value itself against maxOutputBytes / maxTransportBytes
                        let val_bytes = serde_json::to_string(&val).map(|s| s.len()).unwrap_or(0);
                        let total_after = transport_acc
                            .fetch_add(serialized.len(), Ordering::SeqCst)
                            .saturating_add(serialized.len());
                        if total_after > limits.max_transport_bytes {
                            let msg = "code mode exceeded maxTransportBytes".to_owned();
                            *budget_err.lock() = Some(msg.clone());
                            parent_cancel.cancel();
                            if let Some(ref sink) = event_sink {
                                sink(CodeModeCallEvent::End {
                                    execution_id: exec_id,
                                    call_id,
                                    operation: req.operation,
                                    name: tool_name,
                                    status: "failed".to_owned(),
                                    duration_ms,
                                    output: None,
                                    error: Some(msg.clone()),
                                });
                            }
                            json!({ "ok": false, "message": msg }).to_string()
                        } else if val_bytes > limits.max_output_bytes {
                            let msg = "code mode tool output exceeds maxOutputBytes".to_owned();
                            if let Some(ref sink) = event_sink {
                                sink(CodeModeCallEvent::End {
                                    execution_id: exec_id,
                                    call_id,
                                    operation: req.operation,
                                    name: tool_name,
                                    status: "failed".to_owned(),
                                    duration_ms,
                                    output: None,
                                    error: Some(msg.clone()),
                                });
                            }
                            json!({ "ok": false, "message": msg }).to_string()
                        } else {
                            if let Some(ref sink) = event_sink {
                                sink(CodeModeCallEvent::End {
                                    execution_id: exec_id,
                                    call_id,
                                    operation: req.operation,
                                    name: tool_name,
                                    status: if call_cancel.is_cancelled() {
                                        "cancelled".to_owned()
                                    } else {
                                        "succeeded".to_owned()
                                    },
                                    duration_ms,
                                    output: Some(val),
                                    error: None,
                                });
                            }
                            serialized
                        }
                    }
                    Err(err_msg) => {
                        let clipped: String = err_msg.chars().take(4_000).collect();
                        if let Some(ref sink) = event_sink {
                            sink(CodeModeCallEvent::End {
                                execution_id: exec_id,
                                call_id,
                                operation: req.operation,
                                name: tool_name,
                                status: if call_cancel.is_cancelled() {
                                    "cancelled".to_owned()
                                } else {
                                    "failed".to_owned()
                                },
                                duration_ms,
                                output: None,
                                error: Some(clipped.clone()),
                            });
                        }
                        json!({ "ok": false, "message": clipped }).to_string()
                    }
                };

                let _ = req.reply_tx.send(response_str);
            });
            inflight.push(task);
        }

        for task in inflight {
            let _ = task.await;
        }
    });

    let isolate_limits = IsolateLimits {
        max_memory_bytes: options.limits.max_memory_bytes,
        max_stack_bytes: options.limits.max_stack_bytes,
        wall_clock_timeout_ms: options.limits.timeout_ms,
        max_console_logs: options.limits.max_console_logs,
        max_console_line_chars: options.limits.max_console_line_chars,
        freeze_intrinsics: options.limits.freeze_intrinsics,
    };
    let limits_for_vm = options.limits.clone();
    let cancel_for_vm = run_cancel.clone();
    let call_counter = Arc::new(AtomicUsize::new(0));
    let call_counter_for_vm = Arc::clone(&call_counter);
    let call_budget_fatal: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let call_budget_fatal_for_vm = Arc::clone(&call_budget_fatal);

    let vm_outcome = tokio::task::spawn_blocking(move || -> Result<(Value, Vec<String>, bool), VmError> {
        let local_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| VmError::Execution(format!("failed building codeMode isolate runtime: {e}")))?;

        local_rt.block_on(async move {
            let prepared = create_isolated_runtime(
                &isolate_limits,
                "imports are not available in code mode",
                Some(&cancel_for_vm),
            )
            .await?;

            let deadline_tokio = tokio::time::Instant::now()
                + Duration::from_millis(limits_for_vm.timeout_ms);

            let out_json: Result<String, VmError> = AsyncContext::async_with(&prepared.ctx, async |ctx| {
                let req_tx_bridge = req_tx.clone();
                let max_arg_bytes = limits_for_vm.max_argument_bytes;
                let max_calls = limits_for_vm.max_calls;
                let counter = Arc::clone(&call_counter_for_vm);
                let fatal_slot = Arc::clone(&call_budget_fatal_for_vm);
                let cancel_tok = cancel_for_vm.clone();
                let cause_slot = Arc::clone(&prepared.interrupt_cause);

                let host_bridge = Function::new(
                    ctx.clone(),
                    Async(move |operation: String, payload: String| {
                        let req_tx_bridge = req_tx_bridge.clone();
                        let counter = Arc::clone(&counter);
                        let fatal_slot = Arc::clone(&fatal_slot);
                        let tok = cancel_tok.clone();
                        let cause = Arc::clone(&cause_slot);
                        async move {
                            if operation != "call" && operation != "search" {
                                return "{\"ok\":false,\"message\":\"invalid operation\"}".to_owned();
                            }
                            if payload.len() > max_arg_bytes {
                                return "{\"ok\":false,\"message\":\"code mode tool input exceeds maxArgumentBytes\"}".to_owned();
                            }
                            let current = counter.fetch_add(1, Ordering::SeqCst);
                            if current >= max_calls {
                                let msg = format!("code mode exceeded maxCalls ({max_calls})");
                                *fatal_slot.lock() = Some(msg.clone());
                                tok.cancel();
                                return json!({ "ok": false, "message": msg }).to_string();
                            }

                            let (reply_tx, reply_rx) = oneshot::channel::<String>();
                            if req_tx_bridge
                                .send(BridgeRequest {
                                    operation,
                                    payload,
                                    reply_tx,
                                })
                                .is_err()
                            {
                                return "{\"ok\":false,\"message\":\"code mode host bridge closed\"}".to_owned();
                            }

                            tokio::select! {
                                res = reply_rx => match res {
                                    Ok(s) => s,
                                    Err(_) => "{\"ok\":false,\"message\":\"code mode host call cancelled\"}".to_owned(),
                                },
                                _ = tok.cancelled() => {
                                    let mut g = cause.lock();
                                    if g.is_none() {
                                        *g = Some(InterruptCause::Cancelled);
                                    }
                                    "{\"ok\":false,\"message\":\"code mode cancelled\"}".to_owned()
                                }
                                _ = tokio::time::sleep_until(deadline_tokio) => {
                                    {
                                        let mut g = cause.lock();
                                        if g.is_none() {
                                            *g = Some(InterruptCause::TimedOut);
                                        }
                                    }
                                    tok.cancel();
                                    "{\"ok\":false,\"message\":\"code mode timed out\"}".to_owned()
                                }
                            }
                        }
                    }),
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                ctx.globals()
                    .set("__cowork_bridge", host_bridge)
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                // Capture bridge & intrinsics BEFORE sealing and freezing so user mutations or
                // frozen intrinsics never break the private JSON bridge.
                let setup_src = format!(
                    r#"
                    (() => {{
                      const rawBridge = globalThis.__cowork_bridge;
                      delete globalThis.__cowork_bridge;
                      const stringify = JSON.stringify;
                      const parse = JSON.parse;
                      const RealmError = Error;
                      const then = Function.prototype.call.bind(Promise.prototype.then);
                      const freeze = Object.freeze;
                      const active = new Set();

                      const invoke = (operation, input) => {{
                        const promise = (async () => {{
                          const payload = stringify(input);
                          if (typeof payload !== "string") throw new RealmError("tool input must be JSON data");
                          const rawReply = await rawBridge(operation, payload);
                          const response = parse(rawReply);
                          if (!response.ok) throw new RealmError(response.message);
                          return response.value;
                        }})();
                        active.add(promise);
                        then(promise, () => active.delete(promise), () => active.delete(promise));
                        return promise;
                      }};

                      const tools = freeze({{
                        call: (name, args) => invoke("call", {{ name, arguments: args }}),
                        search: (query) => invoke(
                          "search",
                          typeof query === "object" && query !== null ? query : {{ query }}
                        ),
                      }});

                      const drainActive = async () => {{
                        while (active.size > 0) {{
                          const snapshot = Array.from(active);
                          await Promise.allSettled(snapshot);
                          await Promise.resolve();
                        }}
                      }};

                      const maxOut = {};
                      globalThis.__cowork_run_codemode = async (runFn) => {{
                        const value = await runFn(tools);
                        await drainActive();
                        const payload = stringify(value === undefined ? null : value);
                        if (typeof payload !== "string") {{
                          throw new RealmError("return value must be JSON data");
                        }}
                        return payload;
                      }};
                    }})();
                    "#,
                    limits_for_vm.max_output_bytes
                );

                ctx.eval::<(), _>(setup_src.as_bytes())
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let run_wrapper: Function<'_> = ctx
                    .globals()
                    .get("__cowork_run_codemode")
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                let _ = ctx.globals().remove("__cowork_run_codemode");

                install_realm_seal(
                    &ctx,
                    Arc::clone(&prepared.console),
                    DeterminismMode::Live,
                    isolate_limits.freeze_intrinsics,
                    &[],
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let declared = Module::declare(ctx.clone(), "codemode.js", compiled_js)
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                let (evaluated, eval_promise) = declared
                    .eval()
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                eval_promise
                    .into_future::<()>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let run_fn: Function<'_> = evaluated
                    .get("default")
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let exec_promise: Promise<'_> = run_wrapper
                    .call((run_fn,))
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                tokio::select! {
                    res = exec_promise.into_future::<String>() => {
                        res.catch(&ctx)
                            .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))
                    }
                    _ = cancel_for_vm.cancelled() => {
                        prepared.cancel_flag.store(true, Ordering::Relaxed);
                        if *prepared.interrupt_cause.lock() == Some(InterruptCause::TimedOut) {
                            Err(VmError::TimedOut { timeout_ms: limits_for_vm.timeout_ms })
                        } else {
                            Err(VmError::Cancelled)
                        }
                    }
                    _ = tokio::time::sleep_until(deadline_tokio) => {
                        {
                            let mut g = prepared.interrupt_cause.lock();
                            if g.is_none() {
                                *g = Some(InterruptCause::TimedOut);
                            }
                        }
                        prepared.cancel_flag.store(true, Ordering::Relaxed);
                        cancel_for_vm.cancel();
                        Err(VmError::TimedOut { timeout_ms: limits_for_vm.timeout_ms })
                    }
                }
            })
            .await;

            // Drop req_tx so host dispatcher drains and exits; if VM errored, cancel any in-flight host calls
            drop(req_tx);
            if out_json.is_err() {
                cancel_for_vm.cancel();
            }

            let json_payload = out_json?;
            if json_payload.len() > limits_for_vm.max_output_bytes {
                cancel_for_vm.cancel();
                return Err(VmError::Execution(
                    "code mode output exceeds maxOutputBytes".to_owned(),
                ));
            }
            let parsed_val: Value = match serde_json::from_str(&json_payload) {
                Ok(v) => v,
                Err(e) => {
                    cancel_for_vm.cancel();
                    return Err(VmError::Execution(format!(
                        "code mode returned invalid JSON: {e}"
                    )));
                }
            };
            let (logs, logs_truncated) = {
                let g = prepared.console.lock();
                (g.lines.clone(), g.truncated)
            };
            Ok((parsed_val, logs, logs_truncated))
        })
    })
    .await
    .map_err(|e| VmError::Execution(format!("codeMode isolate thread panicked: {e}")));

    if !matches!(vm_outcome, Ok(Ok(_))) {
        run_cancel.cancel();
    }

    // Ensure all dispatched host calls settle before returning
    let _ = dispatcher_handle.await;

    if let Some(fatal_msg) = call_budget_fatal.lock().clone() {
        return Err(VmError::Execution(fatal_msg));
    }
    if let Some(budget_msg) = budget_exceeded_error.lock().clone() {
        return Err(VmError::Execution(budget_msg));
    }

    let (value, logs, logs_truncated) = vm_outcome??;
    Ok(CodeModeExecutionResult {
        value,
        logs,
        logs_truncated,
        call_count: call_counter.load(Ordering::SeqCst),
    })
}
