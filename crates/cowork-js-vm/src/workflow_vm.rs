use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;
use rquickjs::prelude::*;
use rquickjs::{AsyncContext, Function, Module, Promise};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::realm::{
    DeterminismMode, InterruptCause, IsolateLimits, VmError, create_isolated_runtime,
    extract_caught_error, install_realm_seal,
};
use crate::transpile::{CompileIssue, WorkflowCompileResult, compile_workflow_source};
use crate::{DEFAULT_ISOLATE_HEAP_LIMIT_BYTES, DEFAULT_ISOLATE_MAX_STACK_BYTES};

pub const DEFAULT_INSPECTION_TIMEOUT_MS: u64 = 2_000;
pub const WORKFLOW_MAX_AGENTS_PER_RUN: usize = 1_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowMeta {
    pub name: String,
    pub description: String,
    pub phases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectedWorkflow {
    pub js: String,
    pub source_hash: String,
    pub meta: WorkflowMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowAgentBridgeReply {
    pub ok: bool,
    pub value: Option<Value>,
    pub message: Option<String>,
    pub spent_usd: f64,
    pub fatal: bool,
}

#[async_trait]
pub trait WorkflowVmBridge: Send + Sync {
    async fn on_meta(&self, meta: WorkflowMeta) -> Result<(), String>;
    async fn on_phase(&self, title: String) -> Result<(), String>;
    async fn on_log(&self, message: String);
    async fn run_agent(
        &self,
        raw_payload: String,
        cancel: CancellationToken,
    ) -> WorkflowAgentBridgeReply;
}

pub fn validate_workflow_meta_value(raw: &Value) -> Result<WorkflowMeta, Vec<CompileIssue>> {
    let Some(obj) = raw.as_object() else {
        return Err(vec![CompileIssue {
            path: "exports.meta".to_owned(),
            message: "expected meta to be an object".to_owned(),
        }]);
    };

    let mut issues = Vec::new();
    for key in obj.keys() {
        if !matches!(key.as_str(), "name" | "description" | "phases") {
            issues.push(CompileIssue {
                path: format!("exports.meta.{key}"),
                message: format!("unrecognized key \"{key}\" in meta"),
            });
        }
    }

    let name = match obj.get("name").and_then(Value::as_str).map(str::trim) {
        Some(s) if !s.is_empty() && s.chars().count() <= 80 => s.to_owned(),
        Some("") => {
            issues.push(CompileIssue {
                path: "exports.meta.name".to_owned(),
                message: "meta.name must not be empty".to_owned(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(CompileIssue {
                path: "exports.meta.name".to_owned(),
                message: "meta.name must be at most 80 characters".to_owned(),
            });
            String::new()
        }
        None => {
            issues.push(CompileIssue {
                path: "exports.meta.name".to_owned(),
                message: "meta.name is required and must be a string".to_owned(),
            });
            String::new()
        }
    };

    let description = match obj
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
    {
        Some(s) if !s.is_empty() && s.chars().count() <= 500 => s.to_owned(),
        Some("") => {
            issues.push(CompileIssue {
                path: "exports.meta.description".to_owned(),
                message: "meta.description must not be empty".to_owned(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(CompileIssue {
                path: "exports.meta.description".to_owned(),
                message: "meta.description must be at most 500 characters".to_owned(),
            });
            String::new()
        }
        None => {
            issues.push(CompileIssue {
                path: "exports.meta.description".to_owned(),
                message: "meta.description is required and must be a string".to_owned(),
            });
            String::new()
        }
    };

    let mut phases = Vec::new();
    match obj.get("phases").and_then(Value::as_array) {
        Some(arr) if !arr.is_empty() && arr.len() <= 32 => {
            for (idx, item) in arr.iter().enumerate() {
                match item.as_str().map(str::trim) {
                    Some(p) if !p.is_empty() => phases.push(p.to_owned()),
                    _ => issues.push(CompileIssue {
                        path: format!("exports.meta.phases.{idx}"),
                        message: "each phase must be a non-empty string".to_owned(),
                    }),
                }
            }
        }
        Some(arr) if arr.is_empty() => {
            issues.push(CompileIssue {
                path: "exports.meta.phases".to_owned(),
                message: "meta.phases must contain at least 1 phase".to_owned(),
            });
        }
        Some(_) => {
            issues.push(CompileIssue {
                path: "exports.meta.phases".to_owned(),
                message: "meta.phases must contain at most 32 phases".to_owned(),
            });
        }
        None => {
            issues.push(CompileIssue {
                path: "exports.meta.phases".to_owned(),
                message: "meta.phases is required and must be an array of strings".to_owned(),
            });
        }
    }

    if issues.is_empty() {
        Ok(WorkflowMeta {
            name,
            description,
            phases,
        })
    } else {
        Err(issues)
    }
}

/// Compiles and evaluates top-level `meta` + `default` export inside a sandboxed QuickJS isolate
/// with a strict wall-clock timeout (default `2_000`ms) and zero host capabilities.
pub async fn inspect_workflow_source(
    source: &str,
    timeout_ms: u64,
) -> Result<InspectedWorkflow, Vec<CompileIssue>> {
    let (js, source_hash) = match compile_workflow_source(source) {
        WorkflowCompileResult::Ok { js, source_hash } => (js, source_hash),
        WorkflowCompileResult::Err { issues } => return Err(issues),
    };

    let effective_timeout = timeout_ms.max(1);
    let limits = IsolateLimits {
        max_memory_bytes: DEFAULT_ISOLATE_HEAP_LIMIT_BYTES,
        max_stack_bytes: DEFAULT_ISOLATE_MAX_STACK_BYTES,
        wall_clock_timeout_ms: effective_timeout,
        freeze_intrinsics: true,
        ..IsolateLimits::default()
    };

    let js_for_vm = js.clone();
    let eval_res = tokio::task::spawn_blocking(move || -> Result<String, VmError> {
        let local_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| VmError::Execution(format!("failed building inspect isolate: {e}")))?;

        local_rt.block_on(async move {
            let prepared = create_isolated_runtime(
                &limits,
                "imports are not available in workflow scripts; everything you need is the argument to the default export",
                None,
            )
            .await?;

            AsyncContext::async_with(&prepared.ctx, async |ctx| {
                install_realm_seal(
                    &ctx,
                    Arc::clone(&prepared.console),
                    DeterminismMode::WorkflowTraps,
                    limits.freeze_intrinsics,
                    &[],
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))?;

                let inspect_fn: Function<'_> = ctx
                    .eval(
                        r#"
                        ((ns) => {
                          const meta = ns.meta === undefined ? null : ns.meta;
                          return JSON.stringify({
                            meta: JSON.parse(JSON.stringify(meta)),
                            hasDefault: typeof ns.default === "function",
                          });
                        })
                        "#
                        .as_bytes(),
                    )
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))?;

                let declared = Module::declare(ctx.clone(), "workflow_inspect.js", js_for_vm)
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))?;
                let (evaluated, eval_promise) = declared
                    .eval()
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))?;
                eval_promise
                    .into_future::<()>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))?;

                let ns = evaluated
                    .namespace()
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))?;
                inspect_fn
                    .call::<_, String>((ns,))
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &limits, &prepared.interrupt_cause))
            })
            .await
        })
    })
    .await
    .map_err(|e| {
        vec![CompileIssue {
            path: "script".to_owned(),
            message: format!("workflow metadata worker panicked: {e}"),
        }]
    })?;

    let raw_json = match eval_res {
        Ok(s) => s,
        Err(VmError::TimedOut { .. }) => {
            return Err(vec![CompileIssue {
                path: "script".to_owned(),
                message: format!("workflow metadata inspection exceeded {effective_timeout}ms"),
            }]);
        }
        Err(other) => {
            return Err(vec![CompileIssue {
                path: "script".to_owned(),
                message: other.to_string(),
            }]);
        }
    };

    let parsed: Value = serde_json::from_str(&raw_json).map_err(|e| {
        vec![CompileIssue {
            path: "script".to_owned(),
            message: format!("invalid metadata payload: {e}"),
        }]
    })?;

    if parsed.get("hasDefault").and_then(Value::as_bool) != Some(true) {
        return Err(vec![CompileIssue {
            path: "exports.default".to_owned(),
            message: "the default export must be a function".to_owned(),
        }]);
    }

    let meta = validate_workflow_meta_value(parsed.get("meta").unwrap_or(&Value::Null))?;
    Ok(InspectedWorkflow {
        js,
        source_hash,
        meta,
    })
}

enum WorkflowBridgeCommand {
    Meta {
        meta_json: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Phase {
        title: String,
    },
    Log {
        message: String,
    },
    Agent {
        payload: String,
        reply: oneshot::Sender<String>,
    },
}

#[derive(Debug, Clone)]
pub struct WorkflowVmRunOptions {
    pub js: String,
    pub args_json: String,
    pub budget_total: Option<f64>,
    pub run_timeout_ms: u64,
    pub max_memory_bytes: usize,
    pub cancel_token: Option<CancellationToken>,
}

/// Executes a pre-compiled workflow module inside an isolated QuickJS runtime with
/// `DeterminismMode::WorkflowTraps`, frozen intrinsics, `1_000`-agent ceiling, and async host RPCs.
pub async fn execute_workflow_module(
    opts: WorkflowVmRunOptions,
    bridge: Arc<dyn WorkflowVmBridge>,
) -> Result<Value, VmError> {
    if opts
        .cancel_token
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
    {
        return Err(VmError::Cancelled);
    }

    let run_cancel = CancellationToken::new();
    if let Some(parent_cancel) = opts.cancel_token.clone() {
        let child_cancel = run_cancel.clone();
        tokio::spawn(async move {
            parent_cancel.cancelled().await;
            child_cancel.cancel();
        });
    }

    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<WorkflowBridgeCommand>();
    let fatal_host_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let fatal_for_host = Arc::clone(&fatal_host_error);
    let cancel_for_host = run_cancel.clone();

    let host_dispatcher = tokio::spawn(async move {
        let mut inflight = Vec::new();
        while let Some(cmd) = cmd_rx.recv().await {
            match cmd {
                WorkflowBridgeCommand::Meta { meta_json, reply } => {
                    let res = match serde_json::from_str::<Value>(&meta_json) {
                        Ok(val) => match validate_workflow_meta_value(&val) {
                            Ok(meta) => bridge.on_meta(meta).await,
                            Err(issues) => Err(format!(
                                "meta is invalid: {}",
                                issues
                                    .into_iter()
                                    .map(|i| format!("{}: {}", i.path, i.message))
                                    .collect::<Vec<_>>()
                                    .join("; ")
                            )),
                        },
                        Err(e) => Err(format!("meta is invalid: {e}")),
                    };
                    let _ = reply.send(res);
                }
                WorkflowBridgeCommand::Phase { title } => {
                    let clipped: String = title.chars().take(200).collect();
                    let res = bridge.on_phase(clipped).await;
                    if let Err(msg) = res {
                        *fatal_for_host.lock() = Some(msg);
                        cancel_for_host.cancel();
                    }
                }
                WorkflowBridgeCommand::Log { message } => {
                    let clipped: String = message.chars().take(2_000).collect();
                    bridge.on_log(clipped).await;
                }
                WorkflowBridgeCommand::Agent { payload, reply } => {
                    let bridge_ref = Arc::clone(&bridge);
                    let child_cancel = cancel_for_host.child_token();
                    let fatal_slot = Arc::clone(&fatal_for_host);
                    let root_cancel = cancel_for_host.clone();
                    let task = tokio::spawn(async move {
                        let out = bridge_ref.run_agent(payload, child_cancel).await;
                        if out.fatal {
                            let msg = out
                                .message
                                .clone()
                                .unwrap_or_else(|| "workflow fatal error".to_owned());
                            *fatal_slot.lock() = Some(msg);
                            root_cancel.cancel();
                        }
                        let serialized = serde_json::to_string(&out).unwrap_or_else(|_| {
                            "{\"ok\":false,\"value\":null,\"message\":\"failed serializing agent result\",\"spent_usd\":0.0,\"fatal\":false}".to_owned()
                        });
                        let _ = reply.send(serialized);
                    });
                    inflight.push(task);
                }
            }
        }
        for t in inflight {
            let _ = t.await;
        }
    });

    let timeout_ms = opts.run_timeout_ms.max(1);
    let slice_timeout_ms = timeout_ms.min(crate::realm::DEFAULT_WALL_CLOCK_TIMEOUT_MS);
    let isolate_limits = IsolateLimits {
        max_memory_bytes: opts.max_memory_bytes.max(4 * 1024 * 1024),
        max_stack_bytes: DEFAULT_ISOLATE_MAX_STACK_BYTES,
        wall_clock_timeout_ms: slice_timeout_ms,
        freeze_intrinsics: true,
        ..IsolateLimits::default()
    };
    let cancel_for_vm = run_cancel.clone();
    let agent_ceiling_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let ceiling_for_vm = Arc::clone(&agent_ceiling_error);
    let args_json = opts.args_json;
    let budget_total = opts.budget_total;
    let js_code = opts.js;

    let vm_outcome = tokio::task::spawn_blocking(move || -> Result<Value, VmError> {
        let local_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| VmError::Execution(format!("failed building workflow isolate: {e}")))?;

        local_rt.block_on(async move {
            let prepared = create_isolated_runtime(
                &isolate_limits,
                "imports are not available in workflow scripts; everything you need is the argument to the default export",
                Some(&cancel_for_vm),
            )
            .await?;

            let deadline_tokio = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);

            let result_json: Result<String, VmError> = AsyncContext::async_with(&prepared.ctx, async |ctx| {
                let tx_meta = cmd_tx.clone();
                let meta_fn = Function::new(
                    ctx.clone(),
                    Async(move |meta_json: String| {
                        let tx_meta = tx_meta.clone();
                        async move {
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx_meta
                                .send(WorkflowBridgeCommand::Meta {
                                    meta_json,
                                    reply: reply_tx,
                                })
                                .is_err()
                            {
                                return "{\"ok\":false,\"message\":\"workflow host bridge closed\"}".to_owned();
                            }
                            match reply_rx.await {
                                Ok(Ok(())) => "{\"ok\":true}".to_owned(),
                                Ok(Err(msg)) => json!({ "ok": false, "message": msg }).to_string(),
                                Err(_) => "{\"ok\":false,\"message\":\"workflow host bridge closed\"}".to_owned(),
                            }
                        }
                    }),
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let tx_phase = cmd_tx.clone();
                let phase_fn = Function::new(ctx.clone(), move |title: String| {
                    let _ = tx_phase.send(WorkflowBridgeCommand::Phase { title });
                })
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let tx_log = cmd_tx.clone();
                let log_fn = Function::new(ctx.clone(), move |message: String| {
                    let _ = tx_log.send(WorkflowBridgeCommand::Log { message });
                })
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, limits_ref(&isolate_limits), &prepared.interrupt_cause))?;

                let tx_agent = cmd_tx.clone();
                let agent_counter = Arc::new(AtomicUsize::new(0));
                let ceiling_slot = Arc::clone(&ceiling_for_vm);
                let cancel_tok = cancel_for_vm.clone();
                let cause_slot = Arc::clone(&prepared.interrupt_cause);
                let slice_deadline_slot = Arc::clone(&prepared.slice_deadline);

                let agent_fn = Function::new(
                    ctx.clone(),
                    Async(move |payload: String| {
                        let tx_agent = tx_agent.clone();
                        let agent_counter = Arc::clone(&agent_counter);
                        let ceiling_slot = Arc::clone(&ceiling_slot);
                        let tok = cancel_tok.clone();
                        let cause = Arc::clone(&cause_slot);
                        let slice_deadline = Arc::clone(&slice_deadline_slot);
                        async move {
                            let idx = agent_counter.fetch_add(1, Ordering::SeqCst);
                            if idx >= WORKFLOW_MAX_AGENTS_PER_RUN {
                                let msg = format!(
                                    "workflow exceeded the {WORKFLOW_MAX_AGENTS_PER_RUN}-agent ceiling"
                                );
                                *ceiling_slot.lock() = Some(msg.clone());
                                tok.cancel();
                                return json!({
                                    "ok": false,
                                    "value": Value::Null,
                                    "message": msg,
                                    "spent_usd": 0.0,
                                    "fatal": true,
                                })
                                .to_string();
                            }
                            let (reply_tx, reply_rx) = oneshot::channel();
                            if tx_agent
                                .send(WorkflowBridgeCommand::Agent {
                                    payload,
                                    reply: reply_tx,
                                })
                                .is_err()
                            {
                                return "{\"ok\":false,\"value\":null,\"message\":\"workflow host bridge closed\",\"spent_usd\":0.0,\"fatal\":true}".to_owned();
                            }
                            let out = tokio::select! {
                                res = reply_rx => match res {
                                    Ok(s) => s,
                                    Err(_) => "{\"ok\":false,\"value\":null,\"message\":\"workflow cancelled\",\"spent_usd\":0.0,\"fatal\":true}".to_owned(),
                                },
                                _ = tok.cancelled() => {
                                    let mut g = cause.lock();
                                    if g.is_none() {
                                        *g = Some(InterruptCause::Cancelled);
                                    }
                                    "{\"ok\":false,\"value\":null,\"message\":\"workflow cancelled\",\"spent_usd\":0.0,\"fatal\":true}".to_owned()
                                }
                                _ = tokio::time::sleep_until(deadline_tokio) => {
                                    let mut g = cause.lock();
                                    if g.is_none() {
                                        *g = Some(InterruptCause::TimedOut);
                                    }
                                    "{\"ok\":false,\"value\":null,\"message\":\"workflow timed out\",\"spent_usd\":0.0,\"fatal\":true}".to_owned()
                                }
                            };
                            *slice_deadline.lock() =
                                std::time::Instant::now() + Duration::from_millis(slice_timeout_ms);
                            out
                        }
                    }),
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                ctx.globals().set("__wf_meta", meta_fn).catch(&ctx).map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                ctx.globals().set("__wf_phase", phase_fn).catch(&ctx).map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                ctx.globals().set("__wf_log", log_fn).catch(&ctx).map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                ctx.globals().set("__wf_agent", agent_fn).catch(&ctx).map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let budget_total_js = match budget_total {
                    Some(v) if v.is_finite() => v.to_string(),
                    _ => "null".to_owned(),
                };
                let args_json_escaped = serde_json::to_string(&args_json)
                    .unwrap_or_else(|_| "\"{}\"".to_owned());

                let host_setup = format!(
                    r#"
                    (() => {{
                      const rawMeta = globalThis.__wf_meta;
                      const rawPhase = globalThis.__wf_phase;
                      const rawLog = globalThis.__wf_log;
                      const rawAgent = globalThis.__wf_agent;
                      delete globalThis.__wf_meta;
                      delete globalThis.__wf_phase;
                      delete globalThis.__wf_log;
                      delete globalThis.__wf_agent;

                      const stringify = JSON.stringify;
                      const parse = JSON.parse;
                      const freeze = Object.freeze;
                      const defineProperty = Object.defineProperty;
                      const RealmError = Error;
                      const then = Function.prototype.call.bind(Promise.prototype.then);
                      const activeRpcs = new Set();

                      const drainRpcs = async () => {{
                        for (;;) {{
                          await Promise.resolve();
                          const active = Array.from(activeRpcs);
                          if (active.length === 0) {{
                            await Promise.resolve();
                            if (activeRpcs.size === 0) return;
                            continue;
                          }}
                          await Promise.allSettled(active);
                        }}
                      }};

                      const budgetTotal = {budget_total_js};
                      const budgetState = {{ spent: 0 }};

                      const agent = async (prompt, opts) => {{
                        const call = (async () => {{
                          const raw = await rawAgent(stringify({{ prompt, opts: opts || {{}} }}));
                          const parsed = parse(raw);
                          if (typeof parsed.spent_usd === "number" && parsed.spent_usd > budgetState.spent) {{
                            budgetState.spent = parsed.spent_usd;
                          }}
                          if (!parsed.ok) {{
                            const err = new RealmError(parsed.message || "workflow agent failed");
                            throw err;
                          }}
                          return parsed.value;
                        }})();
                        activeRpcs.add(call);
                        then(call, () => activeRpcs.delete(call), () => activeRpcs.delete(call));
                        return await call;
                      }};

                      const parallel = async (thunks) => {{
                        const settled = await Promise.allSettled(Array.from(thunks, (t) => t()));
                        const out = [];
                        for (const r of settled) out.push(r.status === "fulfilled" ? r.value : null);
                        return out;
                      }};

                      const pipeline = async (items, ...stages) => {{
                        const runItem = async (item, index) => {{
                          let acc = item;
                          for (const stage of stages) {{
                            if (acc === null || acc === undefined) return null;
                            acc = await stage(acc, item, index);
                          }}
                          return acc;
                        }};
                        const settled = await Promise.allSettled(Array.from(items, runItem));
                        const out = [];
                        for (const r of settled) out.push(r.status === "fulfilled" ? r.value : null);
                        return out;
                      }};

                      const compact = (items) => Array.from(items).filter((v) => v !== null && v !== undefined);

                      const judge = async (candidate, opts) => {{
                        const n = Math.max(1, Math.min(9, (opts && opts.n) || 3));
                        const rubric = (opts && opts.rubric) || "Is this correct?";
                        const aggregate = (opts && opts.aggregate) || "majority";
                        const agentOpts = Object.assign({{}}, (opts && opts.agent) || {{}});
                        const schema = {{
                          type: "object",
                          properties: {{
                            pass: {{ type: "boolean" }},
                            score: {{ type: "number" }},
                            reason: {{ type: "string" }},
                          }},
                          required: ["pass", "score", "reason"],
                          additionalProperties: false,
                        }};
                        const votes = compact(
                          await parallel(
                            Array.from({{ length: n }}, (_unused, i) => () =>
                              agent(
                                rubric +
                                  "\n\nCandidate:\n" +
                                  (typeof candidate === "string" ? candidate : stringify(candidate, null, 1)) +
                                  "\n\nJudge independently. You are judge " + (i + 1) + " of " + n + ".",
                                Object.assign({{}}, agentOpts, {{
                                  schema,
                                  label: (agentOpts.label || "judge") + ":" + (i + 1),
                                  onError: "null",
                                }})
                              )
                            )
                          )
                        );
                        if (votes.length === 0) return {{ verdict: "fail", score: 0, votes: [] }};
                        const passes = votes.filter((v) => v && v.pass === true).length;
                        const scores = votes.map((v) => (v && typeof v.score === "number" ? v.score : 0));
                        const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
                        let verdict;
                        if (aggregate === "unanimous") verdict = passes === votes.length ? "pass" : "fail";
                        else if (aggregate === "worst") verdict = passes === votes.length ? "pass" : "fail";
                        else if (aggregate === "meanScore") verdict = mean >= 0.5 ? "pass" : "fail";
                        else verdict = passes * 2 > votes.length ? "pass" : "fail";
                        const score = aggregate === "worst" ? Math.min.apply(null, scores) : mean;
                        return {{ verdict, score, votes }};
                      }};

                      let declaredPhases = [];

                      const invokePhase = (label) => {{
                        const title = String(label);
                        rawPhase(title);
                        if (!declaredPhases.includes(title)) {{
                          const decl = declaredPhases.length ? declaredPhases.join(", ") : "(none)";
                          throw new RealmError('unknown phase "' + title + '"; meta.phases declares: ' + decl);
                        }}
                      }};

                      const workflow = async (label, fn) => {{
                        invokePhase(label);
                        return await fn();
                      }};

                      globalThis.__cowork_workflow_driver = {{
                        validateMetaAndPrepare: async (ns) => {{
                          const metaVal = ns.meta === undefined ? null : ns.meta;
                          const metaCopy = parse(stringify(metaVal));
                          const ackRaw = await rawMeta(stringify(metaCopy));
                          const ack = parse(ackRaw);
                          if (!ack.ok) throw new RealmError(ack.message || "invalid workflow meta");
                          if (metaCopy && Array.isArray(metaCopy.phases)) {{
                            declaredPhases = metaCopy.phases.map((p) => String(p));
                          }}
                          if (typeof ns.default !== "function") {{
                            throw new RealmError("the default export must be a function");
                          }}
                          defineProperty(globalThis, "parallel", {{ value: parallel, configurable: false, writable: false }});
                          defineProperty(globalThis, "pipeline", {{ value: pipeline, configurable: false, writable: false }});
                          defineProperty(globalThis, "compact", {{ value: compact, configurable: false, writable: false }});
                          defineProperty(globalThis, "judge", {{ value: judge, configurable: false, writable: false }});
                        }},
                        executeDefault: async (ns) => {{
                          const host = freeze({{
                            agent,
                            parallel,
                            pipeline,
                            compact,
                            judge,
                            workflow,
                            phase: (title) => invokePhase(title),
                            log: (message) => rawLog(String(message)),
                            args: freeze(parse({args_json_escaped})),
                            budget: freeze({{
                              total: budgetTotal,
                              spent: () => budgetState.spent,
                              remaining: () =>
                                budgetTotal === null ? Infinity : Math.max(0, budgetTotal - budgetState.spent),
                            }}),
                          }});
                          const result = await ns.default(host);
                          await drainRpcs();
                          const serialized = stringify(result === undefined ? null : result);
                          if (typeof serialized !== "string") {{
                            throw new RealmError("workflow return value must be JSON data");
                          }}
                          return serialized;
                        }},
                      }};
                    }})();
                    "#
                );

                ctx.eval::<(), _>(host_setup.as_bytes())
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let driver: rquickjs::Object<'_> = ctx
                    .globals()
                    .get("__cowork_workflow_driver")
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                let _ = ctx.globals().remove("__cowork_workflow_driver");

                install_realm_seal(
                    &ctx,
                    Arc::clone(&prepared.console),
                    DeterminismMode::WorkflowTraps,
                    isolate_limits.freeze_intrinsics,
                    &[],
                )
                .catch(&ctx)
                .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                // Evaluate module BEFORE installing `parallel`/`pipeline`/`compact`/`judge` on globalThis
                // so `meta` cannot call any host or workflow primitives during module top-level eval!
                let declared = Module::declare(ctx.clone(), "workflow_run.js", js_code)
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

                let ns = evaluated
                    .namespace()
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let validate_fn: Function<'_> = driver
                    .get("validateMetaAndPrepare")
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                let validate_promise: Promise<'_> = validate_fn
                    .call((ns.clone(),))
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                validate_promise
                    .into_future::<()>()
                    .await
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                let exec_fn: Function<'_> = driver
                    .get("executeDefault")
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;
                let exec_promise: Promise<'_> = exec_fn
                    .call((ns,))
                    .catch(&ctx)
                    .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))?;

                tokio::select! {
                    res = exec_promise.into_future::<String>() => {
                        res.catch(&ctx)
                            .map_err(|e| extract_caught_error(e, &isolate_limits, &prepared.interrupt_cause))
                    }
                    _ = cancel_for_vm.cancelled() => {
                        prepared.cancel_flag.store(true, Ordering::Relaxed);
                        Err(VmError::Cancelled)
                    }
                    _ = tokio::time::sleep_until(deadline_tokio) => {
                        prepared.cancel_flag.store(true, Ordering::Relaxed);
                        Err(VmError::TimedOut { timeout_ms })
                    }
                }
            })
            .await;

            drop(cmd_tx);
            let payload = result_json?;
            serde_json::from_str::<Value>(&payload)
                .map_err(|e| VmError::Execution(format!("workflow returned invalid JSON: {e}")))
        })
    })
    .await
    .map_err(|e| VmError::Execution(format!("workflow isolate thread panicked: {e}")));

    let _ = host_dispatcher.await;

    if let Some(ceiling_msg) = agent_ceiling_error.lock().clone() {
        return Err(VmError::Execution(ceiling_msg));
    }
    if let Some(fatal_msg) = fatal_host_error.lock().clone() {
        return Err(VmError::Execution(fatal_msg));
    }

    vm_outcome?
}

fn limits_ref(l: &IsolateLimits) -> &IsolateLimits {
    l
}
