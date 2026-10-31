use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    canonicalize_with_missing_tail, normalize_and_validate_args,
};

pub const VALID_AGENT_ROLES: &[&str] = &["default", "explorer", "research", "worker", "reviewer"];
pub const VALID_CONTEXT_MODES: &[&str] = &["none", "brief", "full"];

/// Validates and canonicalizes `targetPaths` for `spawnAgent`.
///
/// Rejects:
/// - Empty array `[]` (must omit `targetPaths` for whole-workspace scope)
/// - Empty/whitespace strings
/// - Paths escaping `working_directory` (including via symlinks)
/// - Paths inside `.git` or `.cowork`
pub fn validate_and_resolve_target_paths(
    working_directory: &Path,
    raw_paths: &[String],
) -> ToolResult<Vec<PathBuf>> {
    if raw_paths.is_empty() {
        return Err(ToolError::InvalidArguments(
            "spawnAgent targetPaths must not be empty; omit it for whole-workspace scope."
                .to_owned(),
        ));
    }

    let ws_canon = canonicalize_with_missing_tail(working_directory);
    let mut invalid = Vec::new();
    let mut resolved_out = Vec::with_capacity(raw_paths.len());

    for raw in raw_paths {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            invalid.push(raw.clone());
            continue;
        }
        let candidate = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else {
            ws_canon.join(trimmed)
        };
        let canon = canonicalize_with_missing_tail(&candidate);
        let inside_ws = canon == ws_canon || canon.starts_with(&ws_canon);
        if !inside_ws {
            invalid.push(raw.clone());
            continue;
        }
        let rel = canon.strip_prefix(&ws_canon).unwrap_or(&canon);
        let hits_protected = rel.components().any(|comp| {
            matches!(comp, Component::Normal(os) if {
                let s = os.to_string_lossy();
                s.eq_ignore_ascii_case(".git") || s.eq_ignore_ascii_case(".cowork")
            })
        });
        if hits_protected {
            invalid.push(raw.clone());
            continue;
        }
        if !resolved_out.contains(&canon) {
            resolved_out.push(canon);
        }
    }

    if !invalid.is_empty() {
        return Err(ToolError::InvalidArguments(format!(
            "spawnAgent targetPaths must be inside the workspace and outside .git/.cowork; invalid: {}",
            invalid.join(", ")
        )));
    }

    Ok(resolved_out)
}

pub fn resolve_context_mode_and_briefing(
    context_mode: Option<&str>,
    briefing: Option<&str>,
    fork_context: Option<bool>,
) -> ToolResult<(String, Option<String>)> {
    let mode = match context_mode {
        Some(m) => {
            let trimmed = m.trim();
            if !VALID_CONTEXT_MODES.contains(&trimmed) {
                return Err(ToolError::InvalidArguments(format!(
                    "Invalid contextMode '{trimmed}'; expected 'none', 'brief', or 'full'."
                )));
            }
            if fork_context == Some(true) && trimmed != "full" {
                return Err(ToolError::InvalidArguments(
                    "forkContext=true conflicts with contextMode!='full'.".to_owned(),
                ));
            }
            trimmed.to_owned()
        }
        None => {
            if fork_context == Some(true) {
                "full".to_owned()
            } else {
                "none".to_owned()
            }
        }
    };

    let clean_briefing = briefing
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if mode == "brief" && clean_briefing.is_none() {
        return Err(ToolError::InvalidArguments(
            "spawnAgent requires a non-empty 'briefing' when contextMode is 'brief'.".to_owned(),
        ));
    }

    Ok((mode, clean_briefing))
}

pub fn all_subagent_tools() -> Vec<Arc<dyn BuiltinTool>> {
    vec![
        Arc::new(SpawnAgentTool),
        Arc::new(ListAgentsTool),
        Arc::new(SendAgentInputTool),
        Arc::new(WaitForAgentTool),
        Arc::new(InspectAgentTool),
        Arc::new(ResumeAgentTool),
        Arc::new(CloseAgentTool),
    ]
}

// ============================================================================
// 1. spawnAgent
// ============================================================================

pub struct SpawnAgentTool;

#[async_trait]
impl BuiltinTool for SpawnAgentTool {
    fn name(&self) -> &str {
        "spawnAgent"
    }

    fn description(&self) -> &str {
        "Spawn a collaborative child agent for a well-scoped task. Supports contextMode ('none' | 'brief' | 'full'), targetPaths confinement (which withholds bash), built-in roles, custom profileRef, and model overrides."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "minLength": 1, "maxLength": 20000 },
                "role": {
                    "type": "string",
                    "enum": ["default", "explorer", "research", "worker", "reviewer"]
                },
                "profileRef": { "type": "string" },
                "model": { "type": "string" },
                "reasoningEffort": {
                    "type": "string",
                    "enum": ["none", "minimal", "low", "medium", "high", "xhigh"]
                },
                "nickname": { "type": "string" },
                "taskType": { "type": "string" },
                "targetPaths": {
                    "type": "array",
                    "items": { "type": "string" }
                },
                "contextMode": {
                    "type": "string",
                    "enum": ["none", "brief", "full"]
                },
                "briefing": { "type": "string", "maxLength": 20000 },
                "includeParentTodos": { "type": "boolean" },
                "includeHarnessContext": { "type": "boolean" },
                "forkContext": { "type": "boolean" }
            },
            "required": ["message"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "spawnAgent is blocked in read-only mode.".to_owned(),
            ));
        }
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let mut args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;

        let message = args
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::InvalidArguments("spawnAgent message must not be empty".to_owned())
            })?
            .to_owned();
        args.insert("message".to_owned(), Value::String(message));

        if let Some(nick_val) = args.get("nickname") {
            let nick = nick_val.as_str().unwrap_or("").trim().to_owned();
            if nick.is_empty() {
                return Err(ToolError::InvalidArguments(
                    "spawnAgent nickname must not be empty".to_owned(),
                ));
            }
            args.insert("nickname".to_owned(), Value::String(nick));
        }

        if let Some(tp_val) = args.get("targetPaths") {
            let raw_list: Vec<String> = tp_val
                .as_array()
                .ok_or_else(|| {
                    ToolError::InvalidArguments("targetPaths must be an array".to_owned())
                })?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_owned())
                .collect();
            let resolved = validate_and_resolve_target_paths(&ctx.working_directory, &raw_list)?;
            let as_strings: Vec<Value> = resolved
                .into_iter()
                .map(|p| Value::String(p.to_string_lossy().into_owned()))
                .collect();
            args.insert("targetPaths".to_owned(), Value::Array(as_strings));
        }

        let (mode, briefing) = resolve_context_mode_and_briefing(
            args.get("contextMode").and_then(Value::as_str),
            args.get("briefing").and_then(Value::as_str),
            args.get("forkContext").and_then(Value::as_bool),
        )?;
        args.insert("contextMode".to_owned(), Value::String(mode));
        if let Some(b) = briefing {
            args.insert("briefing".to_owned(), Value::String(b));
        }

        let res = bridge
            .spawn_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 2. listAgents
// ============================================================================

pub struct ListAgentsTool;

#[async_trait]
impl BuiltinTool for ListAgentsTool {
    fn name(&self) -> &str {
        "listAgents"
    }

    fn description(&self) -> &str {
        "List collaborative child agents for the current parent session."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let _ = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .list_agents(&ctx.session_id, json!({}))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 3. sendAgentInput
// ============================================================================

pub struct SendAgentInputTool;

#[async_trait]
impl BuiltinTool for SendAgentInputTool {
    fn name(&self) -> &str {
        "sendAgentInput"
    }

    fn description(&self) -> &str {
        "Send a follow-up message to an existing child agent. Set interrupt=true to steer/interrupt an in-flight turn immediately."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 },
                "message": { "type": "string", "minLength": 1, "maxLength": 20000 },
                "interrupt": { "type": "boolean" }
            },
            "required": ["agentId", "message"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "sendAgentInput is blocked in read-only mode.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .send_agent_input(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 4. waitForAgent
// ============================================================================

pub struct WaitForAgentTool;

#[async_trait]
impl BuiltinTool for WaitForAgentTool {
    fn name(&self) -> &str {
        "waitForAgent"
    }

    fn description(&self) -> &str {
        "Wait for one or more child agents to reach terminal states ('any' or 'all'). Set includeFinalMessage=true and/or includeReport=true to retrieve full output and parsed <agent_report>."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentIds": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": "string", "minLength": 1 }
                },
                "timeoutMs": { "type": "integer", "minimum": 0, "maximum": 300000 },
                "mode": { "type": "string", "enum": ["any", "all"] },
                "includeFinalMessage": { "type": "boolean" },
                "includeReport": { "type": "boolean" }
            },
            "required": ["agentIds"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .wait_for_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 5. inspectAgent
// ============================================================================

pub struct InspectAgentTool;

#[async_trait]
impl BuiltinTool for InspectAgentTool {
    fn name(&self) -> &str {
        "inspectAgent"
    }

    fn description(&self) -> &str {
        "Read the latest detailed result for a child agent, including full assistant text and parsed <agent_report>."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 }
            },
            "required": ["agentId"]
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .inspect_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 6. resumeAgent
// ============================================================================

pub struct ResumeAgentTool;

#[async_trait]
impl BuiltinTool for ResumeAgentTool {
    fn name(&self) -> &str {
        "resumeAgent"
    }

    fn description(&self) -> &str {
        "Resume a previously closed child agent by id so it can receive new input and waits."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 }
            },
            "required": ["agentId"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "resumeAgent is blocked in read-only mode.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .resume_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}

// ============================================================================
// 7. closeAgent
// ============================================================================

pub struct CloseAgentTool;

#[async_trait]
impl BuiltinTool for CloseAgentTool {
    fn name(&self) -> &str {
        "closeAgent"
    }

    fn description(&self) -> &str {
        "Close a child agent when it is no longer needed and return its last known status."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agentId": { "type": "string", "minLength": 1 }
            },
            "required": ["agentId"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "closeAgent is blocked in read-only mode.".to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let bridge = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;
        let res = bridge
            .close_agent(&ctx.session_id, Value::Object(args))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}
