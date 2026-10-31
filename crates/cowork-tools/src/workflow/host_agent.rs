use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cowork_js_vm::{
    SchemaValidation, build_repair_instruction, build_schema_instruction,
    build_schema_system_instruction, extract_result_envelope, validate_against_json_schema,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::agent_tools::VALID_AGENT_ROLES;
use crate::context::{AgentControlBridge, ToolExecutionContext};
use crate::workflow::input_spill::WORKFLOW_MAX_PROMPT_CHARS;

const WAIT_SLICE_MS: u64 = 120_000;
const DEFAULT_AGENT_TIMEOUT_MS: u64 = 600_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowAgentOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub briefing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedWorkflowAgentCall {
    pub prompt: String,
    pub opts: WorkflowAgentOptions,
    pub raw_opts_value: Value,
}

pub fn parse_workflow_agent_call(raw: &str) -> Result<ParsedWorkflowAgentCall, String> {
    let val: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let obj = val
        .as_object()
        .ok_or_else(|| "agent call payload must be an object".to_owned())?;
    for key in obj.keys() {
        if key != "prompt" && key != "opts" {
            return Err(format!("unknown agent call field '{key}'"));
        }
    }
    let prompt = obj
        .get("prompt")
        .and_then(Value::as_str)
        .ok_or_else(|| "prompt must be a string".to_owned())?;
    if prompt.trim().is_empty() {
        return Err("prompt must not be empty".to_owned());
    }
    if prompt.chars().count() > WORKFLOW_MAX_PROMPT_CHARS {
        return Err(format!(
            "prompt exceeds {WORKFLOW_MAX_PROMPT_CHARS} character limit"
        ));
    }

    let raw_opts = match obj.get("opts") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v @ Value::Object(_)) => {
            let mut cleaned = v.clone();
            if let Some(m) = cleaned.as_object_mut() {
                m.retain(|_, val| !val.is_null());
            }
            cleaned
        }
        Some(_) => return Err("opts must be an object".to_owned()),
    };

    let mut opts: WorkflowAgentOptions =
        serde_json::from_value(raw_opts.clone()).map_err(|e| e.to_string())?;

    if let Some(ref at) = opts.agent_type {
        let t = at.trim();
        if t.is_empty() || t.len() > 80 {
            return Err("agentType must be 1..=80 characters".to_owned());
        }
        opts.agent_type = Some(t.to_owned());
    }
    if let Some(ref m) = opts.model {
        let t = m.trim();
        if t.is_empty() || t.len() > 160 {
            return Err("model must be 1..=160 characters".to_owned());
        }
        opts.model = Some(t.to_owned());
    }
    if let Some(ref eff) = opts.effort
        && !matches!(
            eff.as_str(),
            "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
        )
    {
        return Err(format!("invalid effort '{eff}'"));
    }
    if let Some(ref iso) = opts.isolation
        && !matches!(iso.as_str(), "none" | "brief" | "full")
    {
        return Err(format!("invalid isolation '{iso}'"));
    }
    if let Some(ref b) = opts.briefing {
        let t = b.trim();
        if t.is_empty() || t.chars().count() > 16_000 {
            return Err("briefing must be 1..=16000 characters".to_owned());
        }
        opts.briefing = Some(t.to_owned());
    }
    if let Some(ref paths) = opts.target_paths {
        if paths.is_empty() || paths.len() > 64 {
            return Err("targetPaths must contain 1..=64 paths".to_owned());
        }
        if paths.iter().any(|p| p.trim().is_empty()) {
            return Err("targetPaths entries must be non-empty".to_owned());
        }
    }
    if let Some(ref s) = opts.schema
        && !s.is_object()
    {
        return Err("schema must be a JSON object".to_owned());
    }
    if let Some(tms) = opts.timeout_ms
        && !(1_000..=3_600_000).contains(&tms)
    {
        return Err("timeoutMs must be between 1000 and 3600000".to_owned());
    }
    if let Some(ref oe) = opts.on_error
        && !matches!(oe.as_str(), "throw" | "null")
    {
        return Err(format!("invalid onError '{oe}'"));
    }
    if let Some(ref lbl) = opts.label {
        let t = lbl.trim();
        if t.is_empty() || t.chars().count() > 120 {
            return Err("label must be 1..=120 characters".to_owned());
        }
        opts.label = Some(t.to_owned());
    }
    if let Some(ref ph) = opts.phase {
        let t = ph.trim();
        if t.is_empty() || t.chars().count() > 200 {
            return Err("phase must be 1..=200 characters".to_owned());
        }
        opts.phase = Some(t.to_owned());
    }

    let normalized_opts_val = serde_json::to_value(&opts).unwrap_or(raw_opts);
    Ok(ParsedWorkflowAgentCall {
        prompt: prompt.to_owned(),
        opts,
        raw_opts_value: normalized_opts_val,
    })
}

#[derive(Debug, Clone)]
pub struct HostAgentOutcome {
    pub value: Value,
    pub agent_id: String,
    pub usd_cost: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct WorkflowAgentError {
    pub message: String,
    pub agent_id: Option<String>,
    pub fatal: bool,
    pub usd_cost: Option<f64>,
}

impl WorkflowAgentError {
    pub fn new(
        message: impl Into<String>,
        agent_id: Option<String>,
        fatal: bool,
        usd_cost: Option<f64>,
    ) -> Self {
        Self {
            message: message.into(),
            agent_id,
            fatal,
            usd_cost,
        }
    }
}

impl std::fmt::Display for WorkflowAgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub fn is_task_lock_error_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    lower.contains("task_locked")
        || lower.contains("locked by active task")
        || lower.contains("locked by task")
}

async fn race_with_cancel_and_deadline<F, T>(
    fut: F,
    cancel_token: &CancellationToken,
    deadline: Instant,
    agent_id: Option<&str>,
    label: &str,
) -> Result<T, WorkflowAgentError>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    if cancel_token.is_cancelled() {
        return Err(WorkflowAgentError::new(
            "workflow cancelled",
            agent_id.map(str::to_owned),
            true,
            None,
        ));
    }
    let now = Instant::now();
    if now >= deadline {
        let who = agent_id
            .map(str::to_owned)
            .unwrap_or_else(|| format!("\"{label}\""));
        return Err(WorkflowAgentError::new(
            format!("agent {who} timed out"),
            agent_id.map(str::to_owned),
            false,
            None,
        ));
    }

    tokio::select! {
        res = fut => match res {
            Ok(v) => Ok(v),
            Err(err) => {
                let fatal = is_task_lock_error_message(&err);
                Err(WorkflowAgentError::new(err, agent_id.map(str::to_owned), fatal, None))
            }
        },
        _ = cancel_token.cancelled() => {
            Err(WorkflowAgentError::new("workflow cancelled", agent_id.map(str::to_owned), true, None))
        }
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
            let who = agent_id
                .map(str::to_owned)
                .unwrap_or_else(|| format!("\"{label}\""));
            Err(WorkflowAgentError::new(format!("agent {who} timed out"), agent_id.map(str::to_owned), false, None))
        }
    }
}

async fn read_agent_usd_cost(
    control: &Arc<dyn AgentControlBridge>,
    parent_session_id: &str,
    agent_id: &str,
    cancel_token: &CancellationToken,
    deadline: Instant,
    label: &str,
) -> Option<f64> {
    if Instant::now() >= deadline || cancel_token.is_cancelled() {
        return None;
    }
    let res = race_with_cancel_and_deadline(
        control.inspect_agent(parent_session_id, json!({ "agentId": agent_id })),
        cancel_token,
        deadline,
        Some(agent_id),
        label,
    )
    .await
    .ok()?;

    res.get("sessionUsage")
        .and_then(|u| u.get("estimatedTotalCostUsd"))
        .and_then(Value::as_f64)
}

async fn wait_sliced(
    control: &Arc<dyn AgentControlBridge>,
    parent_session_id: &str,
    agent_id: &str,
    cancel_token: &CancellationToken,
    deadline: Instant,
    label: &str,
) -> Result<String, WorkflowAgentError> {
    loop {
        if cancel_token.is_cancelled() {
            return Err(WorkflowAgentError::new(
                "workflow cancelled",
                Some(agent_id.to_owned()),
                true,
                None,
            ));
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(WorkflowAgentError::new(
                format!("agent {agent_id} timed out"),
                Some(agent_id.to_owned()),
                false,
                None,
            ));
        }
        let remaining_ms = deadline.duration_since(now).as_millis() as u64;
        let slice_ms = remaining_ms.clamp(1, WAIT_SLICE_MS);

        let waited = race_with_cancel_and_deadline(
            control.wait_for_agent(
                parent_session_id,
                json!({
                    "agentIds": [agent_id],
                    "timeoutMs": slice_ms,
                    "mode": "all",
                    "includeFinalMessage": true,
                }),
            ),
            cancel_token,
            deadline,
            Some(agent_id),
            label,
        )
        .await?;

        if waited.get("timedOut").and_then(Value::as_bool) == Some(true) {
            continue;
        }

        let exec_state = waited
            .get("agents")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|a| a.get("agentId").and_then(Value::as_str) == Some(agent_id))
            })
            .and_then(|a| a.get("executionState"))
            .and_then(Value::as_str);

        if exec_state == Some("errored") {
            return Err(WorkflowAgentError::new(
                format!("agent {agent_id} errored"),
                Some(agent_id.to_owned()),
                false,
                None,
            ));
        }

        let text = waited
            .get("inspections")
            .and_then(Value::as_array)
            .and_then(|arr| {
                arr.iter()
                    .find(|i| i.get("agentId").and_then(Value::as_str) == Some(agent_id))
            })
            .and_then(|i| i.get("latestAssistantText"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        match text {
            Some(s) => return Ok(s.to_owned()),
            None => {
                if exec_state == Some("closed") {
                    return Err(WorkflowAgentError::new(
                        format!("agent {agent_id} closed without producing a result"),
                        Some(agent_id.to_owned()),
                        false,
                        None,
                    ));
                }
                return Err(WorkflowAgentError::new(
                    format!("agent {agent_id} returned no output"),
                    Some(agent_id.to_owned()),
                    false,
                    None,
                ));
            }
        }
    }
}

pub struct RunWorkflowAgentInput<'a> {
    pub ctx: &'a ToolExecutionContext,
    pub control: &'a Arc<dyn AgentControlBridge>,
    pub cancel_token: &'a CancellationToken,
    pub prompt: String,
    pub input_file_target_path: Option<String>,
    pub options: &'a WorkflowAgentOptions,
    pub label: &'a str,
}

/// Runs one `agent()` call to completion:
/// `spawn_agent` -> `wait_for_agent` -> optional `jsonschema` validation + 1-turn repair ->
/// `inspect_agent` (`usdCost`) -> `close_agent`.
pub async fn run_workflow_agent<F>(
    input: RunWorkflowAgentInput<'_>,
    on_agent_id: F,
) -> Result<HostAgentOutcome, WorkflowAgentError>
where
    F: FnOnce(&str),
{
    let timeout_ms = input.options.timeout_ms.unwrap_or(DEFAULT_AGENT_TIMEOUT_MS);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);

    let message = if let Some(ref schema) = input.options.schema {
        format!("{}\n{}", input.prompt, build_schema_instruction(schema))
    } else {
        input.prompt
    };

    let agent_type = input.options.agent_type.as_deref().map(str::trim);
    let (role, profile_ref) = match agent_type {
        Some(t) if VALID_AGENT_ROLES.contains(&t) => (Some(t), None),
        Some(t) if !t.is_empty() => (None, Some(t)),
        _ => (None, None),
    };

    let target_paths: Option<Vec<String>> = input.options.target_paths.as_ref().map(|paths| {
        let mut dedup = BTreeSet::new();
        let mut out = Vec::new();
        for p in paths {
            if dedup.insert(p.clone()) {
                out.push(p.clone());
            }
        }
        if let Some(ref spill_rel) = input.input_file_target_path
            && dedup.insert(spill_rel.clone())
        {
            out.push(spill_rel.clone());
        }
        out
    });

    let nickname: String = input.label.chars().take(120).collect();
    let mut spawn_params = Map::new();
    spawn_params.insert("message".to_owned(), Value::String(message));
    spawn_params.insert("nickname".to_owned(), Value::String(nickname));
    spawn_params.insert(
        "contextMode".to_owned(),
        Value::String(
            input
                .options
                .isolation
                .clone()
                .unwrap_or_else(|| "none".to_owned()),
        ),
    );
    if input.options.schema.is_some() {
        spawn_params.insert(
            "systemPromptSuffix".to_owned(),
            Value::String(build_schema_system_instruction()),
        );
    }
    if let Some(r) = role {
        spawn_params.insert("role".to_owned(), Value::String(r.to_owned()));
    }
    if let Some(p) = profile_ref {
        spawn_params.insert("profileRef".to_owned(), Value::String(p.to_owned()));
    }
    if let Some(ref m) = input.options.model {
        spawn_params.insert("model".to_owned(), Value::String(m.clone()));
    }
    if let Some(ref eff) = input.options.effort {
        spawn_params.insert("reasoningEffort".to_owned(), Value::String(eff.clone()));
    }
    if let Some(tp) = target_paths {
        spawn_params.insert("targetPaths".to_owned(), json!(tp));
    }
    if let Some(ref b) = input.options.briefing {
        spawn_params.insert("briefing".to_owned(), Value::String(b.clone()));
    }

    let spawned = race_with_cancel_and_deadline(
        input
            .control
            .spawn_agent(&input.ctx.session_id, Value::Object(spawn_params)),
        input.cancel_token,
        deadline,
        None,
        input.label,
    )
    .await?;

    let agent_id = spawned
        .get("agentId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            WorkflowAgentError::new("spawn_agent returned no agentId", None, false, None)
        })?
        .to_owned();

    on_agent_id(&agent_id);

    let run_res: Result<(Value, Option<f64>), WorkflowAgentError> = async {
        let final_text = wait_sliced(
            input.control,
            &input.ctx.session_id,
            &agent_id,
            input.cancel_token,
            deadline,
            input.label,
        )
        .await?;

        let value = if let Some(ref schema) = input.options.schema {
            let first_val = validate_against_json_schema(
                schema,
                extract_result_envelope(Some(&final_text)).as_deref(),
            )
            .map_err(|e| WorkflowAgentError::new(e, Some(agent_id.clone()), false, None))?;
            match first_val {
                SchemaValidation::Ok(parsed) => parsed,
                SchemaValidation::Invalid(issues) => {
                    // Exactly 1 automatic repair turn!
                    race_with_cancel_and_deadline(
                        input.control.send_agent_input(
                            &input.ctx.session_id,
                            json!({
                                "agentId": agent_id,
                                "message": build_repair_instruction(&issues),
                            }),
                        ),
                        input.cancel_token,
                        deadline,
                        Some(&agent_id),
                        input.label,
                    )
                    .await?;

                    let repaired_text = wait_sliced(
                        input.control,
                        &input.ctx.session_id,
                        &agent_id,
                        input.cancel_token,
                        deadline,
                        input.label,
                    )
                    .await?;

                    match validate_against_json_schema(
                        schema,
                        extract_result_envelope(Some(&repaired_text)).as_deref(),
                    )
                    .map_err(|e| WorkflowAgentError::new(e, Some(agent_id.clone()), false, None))?
                    {
                        SchemaValidation::Ok(parsed) => parsed,
                        SchemaValidation::Invalid(repair_issues) => {
                            return Err(WorkflowAgentError::new(
                                format!(
                                    "agent \"{}\" did not return a valid result: {}",
                                    input.label,
                                    repair_issues.join("; ")
                                ),
                                Some(agent_id.clone()),
                                false,
                                None,
                            ));
                        }
                    }
                }
            }
        } else {
            Value::String(final_text)
        };

        let cost = read_agent_usd_cost(
            input.control,
            &input.ctx.session_id,
            &agent_id,
            input.cancel_token,
            deadline,
            input.label,
        )
        .await;

        Ok((value, cost))
    }
    .await;

    let final_outcome = match run_res {
        Ok((value, usd_cost)) => Ok(HostAgentOutcome {
            value,
            agent_id: agent_id.clone(),
            usd_cost,
        }),
        Err(mut err) => {
            if err.usd_cost.is_none() && !err.fatal {
                err.usd_cost = read_agent_usd_cost(
                    input.control,
                    &input.ctx.session_id,
                    &agent_id,
                    input.cancel_token,
                    deadline,
                    input.label,
                )
                .await;
            }
            if err.agent_id.is_none() {
                err.agent_id = Some(agent_id.clone());
            }
            Err(err)
        }
    };

    let _ = input
        .control
        .close_agent(&input.ctx.session_id, json!({ "agentId": agent_id }))
        .await;

    final_outcome
}
