use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Instant;

use async_trait::async_trait;
use cowork_config::ChildModelRoutingMode;
use cowork_js_vm::{
    CompileIssue, DEFAULT_ISOLATE_HEAP_LIMIT_BYTES, WorkflowAgentBridgeReply,
    WorkflowCompileResult, WorkflowJournal, WorkflowJournalEntry, WorkflowJournalOpenOptions,
    WorkflowMeta, WorkflowVmBridge, WorkflowVmRunOptions, compile_workflow_source,
    digest_agent_call, execute_workflow_module, hash_workflow_args,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::context::{AgentControlBridge, ToolExecutionContext};
use crate::workflow::host_agent::{
    RunWorkflowAgentInput, parse_workflow_agent_call, run_workflow_agent,
};
use crate::workflow::input_spill::{WORKFLOW_INLINE_PROMPT_CHARS, spill_workflow_prompt_to_file};

pub const DEFAULT_WORKFLOW_CONCURRENCY: usize = 12;
pub const MAX_WORKFLOW_CONCURRENCY: usize = 16;
pub const DEFAULT_WORKFLOW_RUN_TIMEOUT_MS: u64 = 3_600_000;
pub const MAX_WORKFLOW_LOGS: usize = 500;
pub const MAX_WORKFLOW_ERROR_TEXT_CHARS: usize = 4_000;
pub const MAX_RETAINED_TERMINAL_WORKFLOW_RUNS: usize = 20;

pub fn resolve_workflow_concurrency(configured: Option<usize>) -> usize {
    match configured {
        Some(n) if n >= 1 => n.min(MAX_WORKFLOW_CONCURRENCY),
        _ => DEFAULT_WORKFLOW_CONCURRENCY,
    }
}

fn clip_error_text(msg: &str) -> String {
    msg.chars().take(MAX_WORKFLOW_ERROR_TEXT_CHARS).collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowProgressAgent {
    pub index: usize,
    pub label: String,
    pub phase: Option<String>,
    pub state: String,
    pub agent_id: Option<String>,
    pub usd_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowProgressPayload {
    pub run_id: String,
    pub name: String,
    pub phases: Vec<String>,
    pub current_phase: Option<String>,
    pub agents: Vec<WorkflowProgressAgent>,
    pub logs: Vec<String>,
    pub spent_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

/// Keeps all active runs (`outcome.is_none()`) plus up to `MAX_RETAINED_TERMINAL_WORKFLOW_RUNS`
/// (`20`) most recent terminal runs per session (`src/shared/workflows.ts` parity).
pub fn upsert_retained_workflow_run(runs: &mut Vec<Value>, progress: Value) {
    let incoming_run_id = progress
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if let Some(pos) = runs
        .iter()
        .position(|r| r.get("runId").and_then(Value::as_str) == Some(incoming_run_id.as_str()))
    {
        runs[pos] = progress;
    } else {
        runs.push(progress);
    }

    let terminal_count = runs
        .iter()
        .filter(|r| r.get("outcome").is_some_and(|v| !v.is_null()))
        .count();
    let mut to_drop = terminal_count.saturating_sub(MAX_RETAINED_TERMINAL_WORKFLOW_RUNS);
    if to_drop > 0 {
        runs.retain(|r| {
            let is_terminal = r.get("outcome").is_some_and(|v| !v.is_null());
            if is_terminal && to_drop > 0 {
                to_drop -= 1;
                false
            } else {
                true
            }
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSummary {
    pub run_id: String,
    pub script_hash: String,
    pub name: String,
    pub description: String,
    pub phases: Vec<String>,
    pub agent_count: usize,
    pub cached_count: usize,
    pub errored_count: usize,
    pub spent_usd: f64,
    pub duration_ms: u64,
    pub result: Value,
    pub logs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed_from_run_id: Option<String>,
}

#[derive(Debug, Clone)]
pub enum WorkflowRunOutcome {
    Success(Box<WorkflowRunSummary>),
    CompileFailure(Vec<CompileIssue>),
}

pub struct WorkflowRunOptions {
    pub ctx: ToolExecutionContext,
    pub control: Arc<dyn AgentControlBridge>,
    pub script: String,
    pub args: Option<Value>,
    pub resume_from_run_id: Option<String>,
    pub dry_run: bool,
    pub run_timeout_ms: Option<u64>,
    pub max_memory_bytes: Option<usize>,
    pub expected_name: Option<String>,
}

struct SharedWorkflowRunState {
    run_id: String,
    dry_run: bool,
    expected_name: Option<String>,
    args_hash: String,
    meta: Option<WorkflowMeta>,
    current_phase: Option<String>,
    agents: Vec<WorkflowProgressAgent>,
    logs: Vec<String>,
    spent_usd: f64,
    workflow_budget_limit_usd: Option<f64>,
    budget_stopped: bool,
    live_agent_ids: BTreeSet<String>,
}

impl SharedWorkflowRunState {
    fn snapshot(&self, outcome: Option<&str>, error: Option<&str>) -> WorkflowProgressPayload {
        WorkflowProgressPayload {
            run_id: self.run_id.clone(),
            name: self
                .meta
                .as_ref()
                .map(|m| m.name.clone())
                .unwrap_or_else(|| "workflow".to_owned()),
            phases: self
                .meta
                .as_ref()
                .map(|m| m.phases.clone())
                .unwrap_or_default(),
            current_phase: self.current_phase.clone(),
            agents: self.agents.clone(),
            logs: self.logs.clone(),
            spent_usd: self.spent_usd,
            error: error.map(clip_error_text),
            outcome: outcome.map(str::to_owned),
        }
    }
}

struct RunnerVmBridge {
    ctx: ToolExecutionContext,
    control: Arc<dyn AgentControlBridge>,
    state: Arc<Mutex<SharedWorkflowRunState>>,
    journal: Arc<WorkflowJournal>,
    semaphore: Arc<Semaphore>,
    call_counter: AtomicUsize,
    terminal_claimed: Arc<AtomicBool>,
}

impl RunnerVmBridge {
    fn emit_progress(&self, outcome: Option<&str>, error: Option<&str>) {
        let payload = {
            let guard = self.state.lock();
            if guard.dry_run {
                return;
            }
            guard.snapshot(outcome, error)
        };
        if let Some(ref cb) = self.ctx.on_workflow_progress
            && let Ok(val) = serde_json::to_value(payload)
        {
            cb(val);
        }
    }

    fn record_spend(&self, usd_cost: Option<f64>) -> f64 {
        let Some(cost) = usd_cost.filter(|c| c.is_finite() && *c > 0.0) else {
            return self.state.lock().spent_usd;
        };
        if let Some(ref bridge) = self.ctx.cost_tracker_bridge {
            let _ = bridge.record_unattributed_cost(cost);
        }
        let mut guard = self.state.lock();
        guard.spent_usd += cost;
        if let Some(limit) = guard.workflow_budget_limit_usd
            && guard.spent_usd >= limit
        {
            guard.budget_stopped = true;
        }
        guard.spent_usd
    }

    fn budget_blocks_new_agents(&self) -> bool {
        {
            let guard = self.state.lock();
            if guard.budget_stopped {
                return true;
            }
            if let Some(limit) = guard.workflow_budget_limit_usd
                && guard.spent_usd >= limit
            {
                return true;
            }
        }
        if let Some(ref bridge) = self.ctx.cost_tracker_bridge
            && bridge.get_budget_status().stop_triggered
        {
            return true;
        }
        false
    }

    fn build_cache_options(&self, raw_opts: &Value) -> Value {
        let Some(opts_obj) = raw_opts.as_object() else {
            return raw_opts.clone();
        };
        let mut map = opts_obj.clone();
        let explicit_model = map.get("model").and_then(Value::as_str);
        let has_explicit_provider = explicit_model.is_some_and(|m| {
            m.split_once(':').is_some_and(|(prov, _)| {
                matches!(
                    prov.trim(),
                    "openai"
                        | "anthropic"
                        | "google"
                        | "openrouter"
                        | "bedrock"
                        | "xai"
                        | "groq"
                        | "mistral"
                        | "deepseek"
                        | "togetherai"
                        | "fireworks"
                        | "perplexity"
                        | "cerebras"
                        | "cohere"
                        | "lmstudio"
                        | "codex-cli"
                )
            })
        });

        let provider_str = self.ctx.provider.as_str().to_owned();
        if explicit_model.is_some() {
            if !has_explicit_provider {
                map.insert("provider".to_owned(), Value::String(provider_str));
            }
        } else {
            map.insert("provider".to_owned(), Value::String(provider_str));
            map.insert("model".to_owned(), Value::String(self.ctx.model.clone()));
            let routing_mode = self
                .ctx
                .agent_config
                .as_ref()
                .map(|c| match c.child_model_routing_mode {
                    ChildModelRoutingMode::SameProvider => "same-provider",
                    ChildModelRoutingMode::CrossProviderAllowlist => "cross-provider-allowlist",
                })
                .unwrap_or("same-provider");
            map.insert(
                "childModelRoutingMode".to_owned(),
                Value::String(routing_mode.to_owned()),
            );
            if routing_mode == "cross-provider-allowlist"
                && let Some(ref cfg) = self.ctx.agent_config
                && !cfg.allowed_child_model_refs.is_empty()
            {
                let mut sorted = cfg.allowed_child_model_refs.clone();
                sorted.sort();
                sorted.dedup();
                map.insert("allowedChildModelRefs".to_owned(), json!(sorted));
            }
        }
        Value::Object(map)
    }
}

#[async_trait]
impl WorkflowVmBridge for RunnerVmBridge {
    async fn on_meta(&self, meta: WorkflowMeta) -> Result<(), String> {
        let mut guard = self.state.lock();
        if let Some(ref expected) = guard.expected_name
            && &meta.name != expected
        {
            return Err(format!(
                "workflow filename/name mismatch: expected meta.name \"{expected}\", found \"{}\"",
                meta.name
            ));
        }
        guard.meta = Some(meta);
        Ok(())
    }

    async fn on_phase(&self, title: String) -> Result<(), String> {
        {
            let mut guard = self.state.lock();
            let declared = guard
                .meta
                .as_ref()
                .map(|m| m.phases.clone())
                .unwrap_or_default();
            if !declared.contains(&title) {
                let decl_str = if declared.is_empty() {
                    "(none)".to_owned()
                } else {
                    declared.join(", ")
                };
                return Err(format!(
                    "unknown phase \"{title}\"; meta.phases declares: {decl_str}"
                ));
            }
            guard.current_phase = Some(title);
        }
        self.emit_progress(None, None);
        Ok(())
    }

    async fn on_log(&self, message: String) {
        let pushed = {
            let mut guard = self.state.lock();
            if guard.logs.len() < MAX_WORKFLOW_LOGS {
                guard.logs.push(message);
                true
            } else {
                false
            }
        };
        if pushed {
            self.emit_progress(None, None);
        }
    }

    async fn run_agent(
        &self,
        raw_payload: String,
        cancel_token: CancellationToken,
    ) -> WorkflowAgentBridgeReply {
        let index = self.call_counter.fetch_add(1, Ordering::SeqCst);

        let parsed = match parse_workflow_agent_call(&raw_payload) {
            Ok(p) => {
                let phase_err = {
                    let guard = self.state.lock();
                    if let (Some(ph), Some(meta)) = (&p.opts.phase, &guard.meta)
                        && !meta.phases.contains(ph)
                    {
                        Some(format!(
                            "unknown phase \"{ph}\"; meta.phases declares: {}",
                            meta.phases.join(", ")
                        ))
                    } else {
                        None
                    }
                };
                match phase_err {
                    Some(e) => Err(e),
                    None => Ok(p),
                }
            }
            Err(e) => Err(e),
        };

        let call = match parsed {
            Ok(c) => c,
            Err(err_msg) => {
                let message = format!("invalid agent() call: {}", clip_error_text(&err_msg));
                let spent = {
                    let mut guard = self.state.lock();
                    let fallback_phase = guard.current_phase.clone();
                    guard.agents.push(WorkflowProgressAgent {
                        index,
                        label: format!("agent-{}", index + 1),
                        phase: fallback_phase,
                        state: "errored".to_owned(),
                        agent_id: None,
                        usd_cost: None,
                        error: Some(message.clone()),
                    });
                    guard.spent_usd
                };
                self.emit_progress(None, None);
                return WorkflowAgentBridgeReply {
                    ok: false,
                    value: None,
                    message: Some(message),
                    spent_usd: spent,
                    fatal: false,
                };
            }
        };

        let label = call
            .opts
            .label
            .clone()
            .unwrap_or_else(|| format!("agent-{}", index + 1));
        let phase = {
            let mut guard = self.state.lock();
            let eff_phase = call
                .opts
                .phase
                .clone()
                .or_else(|| guard.current_phase.clone());
            guard.agents.push(WorkflowProgressAgent {
                index,
                label: label.clone(),
                phase: eff_phase.clone(),
                state: "queued".to_owned(),
                agent_id: None,
                usd_cost: None,
                error: None,
            });
            eff_phase
        };
        self.emit_progress(None, None);

        let args_hash = self.state.lock().args_hash.clone();
        let cache_opts = self.build_cache_options(&call.raw_opts_value);
        let digest = digest_agent_call(&args_hash, &call.prompt, &cache_opts);

        if let Some(cached) = self.journal.lookup(&digest) {
            let spent = {
                let mut guard = self.state.lock();
                if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                    row.state = "cached".to_owned();
                    row.set_zero_cost();
                }
                guard.spent_usd
            };
            self.emit_progress(None, None);
            if !self.state.lock().dry_run {
                let mut replayed = cached.clone();
                replayed.index = index;
                replayed.digest = digest;
                let _ = self.journal.append(&replayed).await;
            }
            return WorkflowAgentBridgeReply {
                ok: true,
                value: Some(cached.result),
                message: None,
                spent_usd: spent,
                fatal: false,
            };
        }

        let permit = tokio::select! {
            p = self.semaphore.clone().acquire_owned() => match p {
                Ok(p) => p,
                Err(_) => {
                    return WorkflowAgentBridgeReply {
                        ok: false,
                        value: None,
                        message: Some("workflow cancelled".to_owned()),
                        spent_usd: self.state.lock().spent_usd,
                        fatal: true,
                    };
                }
            },
            _ = cancel_token.cancelled() => {
                return WorkflowAgentBridgeReply {
                    ok: false,
                    value: None,
                    message: Some("workflow cancelled".to_owned()),
                    spent_usd: self.state.lock().spent_usd,
                    fatal: true,
                };
            }
        };

        if cancel_token.is_cancelled() || self.ctx.is_cancelled() {
            drop(permit);
            return WorkflowAgentBridgeReply {
                ok: false,
                value: None,
                message: Some("workflow cancelled".to_owned()),
                spent_usd: self.state.lock().spent_usd,
                fatal: true,
            };
        }

        let is_dry_run = self.state.lock().dry_run;
        if !is_dry_run && self.budget_blocks_new_agents() {
            drop(permit);
            let message = "workflow budget exhausted".to_owned();
            if call.opts.on_error.as_deref() == Some("null") {
                let spent = {
                    let mut guard = self.state.lock();
                    if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                        row.state = "errored".to_owned();
                        row.error = Some(message);
                    }
                    guard.spent_usd
                };
                self.emit_progress(None, None);
                return WorkflowAgentBridgeReply {
                    ok: true,
                    value: Some(Value::Null),
                    message: None,
                    spent_usd: spent,
                    fatal: false,
                };
            }
            let spent = {
                let mut guard = self.state.lock();
                if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                    row.state = "errored".to_owned();
                    row.error = Some(message.clone());
                }
                guard.spent_usd
            };
            self.emit_progress(None, None);
            return WorkflowAgentBridgeReply {
                ok: false,
                value: None,
                message: Some(message),
                spent_usd: spent,
                fatal: false,
            };
        }

        {
            let mut guard = self.state.lock();
            if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                row.state = "running".to_owned();
            }
        }
        self.emit_progress(None, None);

        if is_dry_run {
            drop(permit);
            let spent = {
                let mut guard = self.state.lock();
                if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                    row.state = "completed".to_owned();
                    row.usd_cost = Some(0.0);
                }
                guard.spent_usd
            };
            let stub_val = Value::String(format!("[dry-run] {label}"));
            return WorkflowAgentBridgeReply {
                ok: true,
                value: Some(stub_val),
                message: None,
                spent_usd: spent,
                fatal: false,
            };
        }

        let prepared_spill = if call.prompt.chars().count() > WORKFLOW_INLINE_PROMPT_CHARS {
            match self
                .ctx
                .check_before_tool_invocation("workflowInputSpill")
                .map_err(|e| e.to_string())
                .and_then(|()| {
                    spill_workflow_prompt_to_file(
                        &call.prompt,
                        &self.ctx.working_directory,
                        call.opts.input_format.as_deref(),
                    )
                }) {
                Ok(spilled) => {
                    let pushed = {
                        let mut guard = self.state.lock();
                        if guard.logs.len() < MAX_WORKFLOW_LOGS {
                            guard.logs.push(format!(
                                "{label} received {} characters through {}.",
                                format_commas(spilled.chars),
                                spilled.target_path
                            ));
                            true
                        } else {
                            false
                        }
                    };
                    if pushed {
                        self.emit_progress(None, None);
                    }
                    Some(spilled)
                }
                Err(err_msg) => {
                    drop(permit);
                    let fatal = crate::workflow::host_agent::is_task_lock_error_message(&err_msg);
                    let clipped = clip_error_text(&err_msg);
                    let spent = {
                        let mut guard = self.state.lock();
                        if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                            row.state = "errored".to_owned();
                            row.error = Some(clipped.clone());
                        }
                        guard.spent_usd
                    };
                    self.emit_progress(None, None);
                    if !fatal && call.opts.on_error.as_deref() == Some("null") {
                        return WorkflowAgentBridgeReply {
                            ok: true,
                            value: Some(Value::Null),
                            message: None,
                            spent_usd: spent,
                            fatal: false,
                        };
                    }
                    return WorkflowAgentBridgeReply {
                        ok: false,
                        value: None,
                        message: Some(clipped),
                        spent_usd: spent,
                        fatal,
                    };
                }
            }
        } else {
            None
        };

        let effective_prompt = prepared_spill
            .as_ref()
            .map(|s| s.prompt.clone())
            .unwrap_or_else(|| call.prompt.clone());
        let spill_rel = prepared_spill.map(|s| s.target_path);

        let state_for_spawn = Arc::clone(&self.state);
        let outcome = run_workflow_agent(
            RunWorkflowAgentInput {
                ctx: &self.ctx,
                control: &self.control,
                cancel_token: &cancel_token,
                prompt: effective_prompt,
                input_file_target_path: spill_rel,
                options: &call.opts,
                label: &label,
            },
            |agent_id| {
                {
                    let mut guard = state_for_spawn.lock();
                    guard.live_agent_ids.insert(agent_id.to_owned());
                    if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                        row.agent_id = Some(agent_id.to_owned());
                    }
                }
                self.emit_progress(None, None);
            },
        )
        .await;

        drop(permit);

        match outcome {
            Ok(ok_out) => {
                let spent = self.record_spend(ok_out.usd_cost);
                {
                    let mut guard = self.state.lock();
                    guard.live_agent_ids.remove(&ok_out.agent_id);
                    if !self.terminal_claimed.load(Ordering::SeqCst)
                        && let Some(row) = guard.agents.iter_mut().find(|r| r.index == index)
                    {
                        row.usd_cost = ok_out.usd_cost;
                        row.state = "completed".to_owned();
                    }
                }
                self.emit_progress(None, None);
                let _ = self
                    .journal
                    .append(&WorkflowJournalEntry {
                        index,
                        digest,
                        phase,
                        label: Some(label),
                        result: ok_out.value.clone(),
                        agent_id: Some(ok_out.agent_id),
                        usd_cost: ok_out.usd_cost,
                    })
                    .await;
                WorkflowAgentBridgeReply {
                    ok: true,
                    value: Some(ok_out.value),
                    message: None,
                    spent_usd: spent,
                    fatal: false,
                }
            }
            Err(err) => {
                let spent = self.record_spend(err.usd_cost);
                let clipped = clip_error_text(&err.message);
                let row_agent_id = {
                    let mut guard = self.state.lock();
                    if let Some(ref aid) = err.agent_id {
                        guard.live_agent_ids.remove(aid);
                    }
                    let mut aid_out = err.agent_id.clone();
                    if let Some(row) = guard.agents.iter_mut().find(|r| r.index == index) {
                        row.usd_cost = err.usd_cost;
                        row.state = "errored".to_owned();
                        row.error = Some(clipped.clone());
                        if aid_out.is_none() {
                            aid_out = row.agent_id.clone();
                        }
                    }
                    aid_out
                };
                self.emit_progress(None, None);

                if err.fatal {
                    return WorkflowAgentBridgeReply {
                        ok: false,
                        value: None,
                        message: Some(clipped),
                        spent_usd: spent,
                        fatal: true,
                    };
                }

                if call.opts.on_error.as_deref() == Some("null") {
                    if let Some(aid) = row_agent_id {
                        let _ = self
                            .journal
                            .append(&WorkflowJournalEntry {
                                index,
                                digest,
                                phase,
                                label: Some(label),
                                result: Value::Null,
                                agent_id: Some(aid),
                                usd_cost: err.usd_cost,
                            })
                            .await;
                    }
                    return WorkflowAgentBridgeReply {
                        ok: true,
                        value: Some(Value::Null),
                        message: None,
                        spent_usd: spent,
                        fatal: false,
                    };
                }

                WorkflowAgentBridgeReply {
                    ok: false,
                    value: None,
                    message: Some(clipped),
                    spent_usd: spent,
                    fatal: false,
                }
            }
        }
    }
}

impl WorkflowProgressAgent {
    fn set_zero_cost(&mut self) {
        self.usd_cost = Some(0.0);
    }
}

fn format_commas(mut n: usize) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let mut parts = Vec::new();
    while n > 0 {
        if n >= 1000 {
            parts.push(format!("{:03}", n % 1000));
        } else {
            parts.push(n.to_string());
        }
        n /= 1000;
    }
    parts.reverse();
    parts.join(",")
}

pub async fn run_workflow(opts: WorkflowRunOptions) -> Result<WorkflowRunOutcome, String> {
    let (compiled_js, compiled_source_hash) = match compile_workflow_source(&opts.script) {
        WorkflowCompileResult::Ok { js, source_hash } => (js, source_hash),
        WorkflowCompileResult::Err { issues } => {
            return Ok(WorkflowRunOutcome::CompileFailure(issues));
        }
    };

    let args_val = opts
        .args
        .clone()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let args_json = match serde_json::to_string(&args_val) {
        Ok(s) => s,
        Err(e) => {
            return Ok(WorkflowRunOutcome::CompileFailure(vec![CompileIssue {
                path: "args".to_owned(),
                message: format!("args must be JSON-serializable: {e}"),
            }]));
        }
    };

    if opts.dry_run && opts.resume_from_run_id.is_some() {
        return Ok(WorkflowRunOutcome::CompileFailure(vec![CompileIssue {
            path: "resumeFromRunId".to_owned(),
            message: "dryRun cannot resume from a prior journal".to_owned(),
        }]));
    }

    if opts.ctx.is_cancelled() {
        return Err("workflow cancelled".to_owned());
    }

    let uuid_hex = Uuid::new_v4().simple().to_string();
    let run_id = format!("wf_{}", &uuid_hex[..12]);
    let started_at = Instant::now();
    let run_timeout_ms = opts
        .run_timeout_ms
        .unwrap_or(DEFAULT_WORKFLOW_RUN_TIMEOUT_MS)
        .max(1);

    let project_cowork_dir: PathBuf = opts
        .ctx
        .agent_config
        .as_ref()
        .map(|c| c.project_cowork_dir.clone())
        .unwrap_or_else(|| opts.ctx.working_directory.join(".cowork"));

    let journal = Arc::new(
        WorkflowJournal::open(WorkflowJournalOpenOptions {
            project_cowork_dir,
            run_id: run_id.clone(),
            persist: !opts.dry_run,
            resume_from_run_id: opts.resume_from_run_id.clone(),
        })
        .await?,
    );

    let budget_status = opts
        .ctx
        .cost_tracker_bridge
        .as_ref()
        .map(|b| b.get_budget_status());
    let stop_at_usd = budget_status.and_then(|b| b.stop_at_usd);
    let baseline_usd = budget_status
        .and_then(|b| b.current_cost_usd)
        .unwrap_or(0.0)
        .max(0.0);
    let workflow_budget_limit_usd = stop_at_usd.map(|stop| (stop - baseline_usd).max(0.0));
    let budget_stopped =
        budget_status.is_some_and(|b| b.stop_triggered) || workflow_budget_limit_usd == Some(0.0);

    let configured_conc = opts
        .ctx
        .agent_config
        .as_ref()
        .map(|c| c.workflow_max_concurrent_agents);
    let concurrency = if workflow_budget_limit_usd.is_some() {
        1
    } else {
        resolve_workflow_concurrency(configured_conc)
    };

    let state = Arc::new(Mutex::new(SharedWorkflowRunState {
        run_id: run_id.clone(),
        dry_run: opts.dry_run,
        expected_name: opts.expected_name,
        args_hash: hash_workflow_args(&args_val),
        meta: None,
        current_phase: None,
        agents: Vec::new(),
        logs: Vec::new(),
        spent_usd: 0.0,
        workflow_budget_limit_usd,
        budget_stopped,
        live_agent_ids: BTreeSet::new(),
    }));

    let terminal_claimed = Arc::new(AtomicBool::new(false));
    let bridge = Arc::new(RunnerVmBridge {
        ctx: opts.ctx.clone(),
        control: Arc::clone(&opts.control),
        state: Arc::clone(&state),
        journal: Arc::clone(&journal),
        semaphore: Arc::new(Semaphore::new(concurrency)),
        call_counter: AtomicUsize::new(0),
        terminal_claimed: Arc::clone(&terminal_claimed),
    });

    let cancel_token = CancellationToken::new();
    let watcher = opts.ctx.cancel_rx.clone().map(|mut rx| {
        let tok = cancel_token.clone();
        tokio::spawn(async move {
            if *rx.borrow() {
                tok.cancel();
                return;
            }
            while rx.changed().await.is_ok() {
                if *rx.borrow() {
                    tok.cancel();
                    break;
                }
            }
        })
    });

    let vm_res = execute_workflow_module(
        WorkflowVmRunOptions {
            js: compiled_js,
            args_json,
            budget_total: workflow_budget_limit_usd,
            run_timeout_ms,
            max_memory_bytes: opts
                .max_memory_bytes
                .unwrap_or(DEFAULT_ISOLATE_HEAP_LIMIT_BYTES),
            cancel_token: Some(cancel_token.clone()),
        },
        Arc::clone(&bridge) as Arc<dyn WorkflowVmBridge>,
    )
    .await;

    if let Some(h) = watcher {
        h.abort();
    }
    terminal_claimed.store(true, Ordering::SeqCst);
    cancel_token.cancel();

    // Ensure any stray live child agents are closed on teardown
    let lingering: Vec<String> = state.lock().live_agent_ids.iter().cloned().collect();
    for aid in lingering {
        let _ = opts
            .control
            .close_agent(&opts.ctx.session_id, json!({ "agentId": aid }))
            .await;
    }
    if !opts.dry_run {
        let _ = journal.flush().await;
    }

    match vm_res {
        Ok(result_val) => {
            bridge.emit_progress(Some("completed"), None);
            let guard = state.lock();
            let meta = guard.meta.clone().unwrap_or(WorkflowMeta {
                name: "workflow".to_owned(),
                description: String::new(),
                phases: Vec::new(),
            });
            let cached_count = guard.agents.iter().filter(|a| a.state == "cached").count();
            let errored_count = guard.agents.iter().filter(|a| a.state == "errored").count();
            Ok(WorkflowRunOutcome::Success(Box::new(WorkflowRunSummary {
                run_id,
                script_hash: compiled_source_hash,
                name: meta.name,
                description: meta.description,
                phases: meta.phases,
                agent_count: guard.agents.len(),
                cached_count,
                errored_count,
                spent_usd: guard.spent_usd,
                duration_ms: started_at.elapsed().as_millis() as u64,
                result: result_val,
                logs: guard.logs.clone(),
                resumed_from_run_id: opts.resume_from_run_id,
            })))
        }
        Err(vm_err) => {
            let is_cancelled =
                matches!(vm_err, cowork_js_vm::VmError::Cancelled) || opts.ctx.is_cancelled();
            let err_msg = if matches!(vm_err, cowork_js_vm::VmError::TimedOut { .. }) {
                format!("workflow {run_id} exceeded {run_timeout_ms}ms")
            } else if is_cancelled {
                "workflow cancelled".to_owned()
            } else {
                vm_err.to_string()
            };
            {
                let mut guard = state.lock();
                for row in &mut guard.agents {
                    if row.state == "queued" || row.state == "running" {
                        row.state = "errored".to_owned();
                        if !is_cancelled {
                            row.error = Some(clip_error_text(&err_msg));
                        }
                    }
                }
            }
            let outcome_label = if is_cancelled { "cancelled" } else { "errored" };
            bridge.emit_progress(Some(outcome_label), Some(&err_msg));
            Err(err_msg)
        }
    }
}
