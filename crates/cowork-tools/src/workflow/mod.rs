pub mod host_agent;
pub mod input_spill;
pub mod registry;
pub mod runner;

use async_trait::async_trait;
use cowork_js_vm::assert_safe_workflow_run_id;
use cowork_sandbox::SandboxPolicy;
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
};
use crate::workflow::registry::{
    WORKFLOW_DEFINITION_MAX_BYTES, WorkflowDefinitionScope, WorkflowRegistryPaths,
    assert_workflow_definition_name, list_workflow_definitions,
    resolve_workflow_definition_for_execution, save_workflow_definition,
};
use crate::workflow::runner::{WorkflowRunOptions, WorkflowRunOutcome, run_workflow};

pub const WORKFLOW_TOOL_DESCRIPTION: &str = "Run, save, or list multi-agent TypeScript workflows (`meta` + `export default async function({ workflow, agent, parallel, pipeline, judge, compact, phase, log, args, budget })`).";

pub struct WorkflowTool;

impl WorkflowTool {
    fn registry_paths(ctx: &ToolExecutionContext) -> WorkflowRegistryPaths {
        let project_cowork_dir = ctx
            .agent_config
            .as_ref()
            .map(|c| c.project_cowork_dir.clone())
            .unwrap_or_else(|| ctx.working_directory.join(".cowork"));
        let user_cowork_dir = ctx
            .agent_config
            .as_ref()
            .map(|c| c.user_cowork_dir.clone())
            .unwrap_or_else(|| ctx.cowork_home.clone());
        let built_in_dir = ctx
            .built_in_dir
            .clone()
            .or_else(|| ctx.agent_config.as_ref().map(|c| c.built_in_dir.clone()));
        WorkflowRegistryPaths {
            project_cowork_dir,
            user_cowork_dir,
            built_in_dir,
        }
    }

    fn assert_can_mutate_workflow(ctx: &ToolExecutionContext) -> ToolResult<()> {
        match &ctx.sandbox_policy {
            SandboxPolicy::ReadOnly { .. } => {
                return Err(ToolError::Execution(
                    "workflow mutation blocked: sandbox mode is read-only".to_owned(),
                ));
            }
            SandboxPolicy::NoProjectWrite { .. } => {
                return Err(ToolError::Execution(
                    "workflow mutation blocked: sandbox mode is no-project-write".to_owned(),
                ));
            }
            _ => {}
        }
        if ctx.read_only_role {
            return Err(ToolError::Execution(
                "workflow mutation blocked: role is read-only".to_owned(),
            ));
        }
        ctx.check_before_tool_invocation("workflow")
    }
}

#[async_trait]
impl BuiltinTool for WorkflowTool {
    fn name(&self) -> &str {
        "workflow"
    }

    fn description(&self) -> &str {
        WORKFLOW_TOOL_DESCRIPTION
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["run", "save", "list"],
                    "description": "Workflow operation (default: 'run')."
                },
                "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 80,
                    "description": "Registered workflow name (lowercase letters, digits, and single hyphens)."
                },
                "script": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": WORKFLOW_DEFINITION_MAX_BYTES,
                    "description": "TypeScript module exporting `meta` and a default async function."
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "global"],
                    "description": "Where to save a reusable workflow definition."
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "Replace an existing workflow in the selected scope."
                },
                "args": {
                    "description": "JSON value exposed to the script as `args`."
                },
                "resumeFromRunId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 64,
                    "description": "Replay a prior run's journal: unchanged agent() calls return cached results at $0 model cost."
                },
                "dryRun": {
                    "type": "boolean",
                    "description": "Execute the script with agent() stubbed without spawning child agents."
                }
            }
        })
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::Sequential
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        const ALLOWED_KEYS: &[&str] = &[
            "action",
            "name",
            "script",
            "scope",
            "overwrite",
            "args",
            "resumeFromRunId",
            "dryRun",
        ];
        // Strip null optional fields except `args` (if caller explicitly passed null as args, keep or strip? In TS `args: undefined` vs `args: null` - keep `args` if non-null, strip nulls on optional metadata fields)
        for key in [
            "action",
            "name",
            "script",
            "scope",
            "overwrite",
            "resumeFromRunId",
            "dryRun",
        ] {
            if raw_args.get(key).is_some_and(Value::is_null) {
                raw_args.remove(key);
            }
        }
        for k in raw_args.keys() {
            if !ALLOWED_KEYS.contains(&k.as_str()) {
                return Err(ToolError::InvalidArguments(format!(
                    "Invalid workflow arguments: unknown field '{k}'"
                )));
            }
        }

        let action = match raw_args.get("action") {
            None => "run".to_owned(),
            Some(Value::String(s)) if matches!(s.as_str(), "run" | "save" | "list") => s.clone(),
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "action must be 'run', 'save', or 'list'".to_owned(),
                ));
            }
        };

        let name_opt = match raw_args.get("name") {
            None => None,
            Some(Value::String(s)) => {
                Some(assert_workflow_definition_name(s).map_err(ToolError::InvalidArguments)?)
            }
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "name must be a string".to_owned(),
                ));
            }
        };

        let script_opt = match raw_args.get("script") {
            None => None,
            Some(Value::String(s)) => {
                let trimmed = s.trim();
                if trimmed.is_empty() || trimmed.len() > WORKFLOW_DEFINITION_MAX_BYTES {
                    return Err(ToolError::InvalidArguments(format!(
                        "script must be 1..={WORKFLOW_DEFINITION_MAX_BYTES} bytes"
                    )));
                }
                Some(trimmed.to_owned())
            }
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "script must be a string".to_owned(),
                ));
            }
        };

        let scope_opt = match raw_args.get("scope") {
            None => None,
            Some(Value::String(s)) if s == "project" => Some(WorkflowDefinitionScope::Project),
            Some(Value::String(s)) if s == "global" => Some(WorkflowDefinitionScope::Global),
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "scope must be 'project' or 'global'".to_owned(),
                ));
            }
        };

        let overwrite_opt = match raw_args.get("overwrite") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "overwrite must be a boolean".to_owned(),
                ));
            }
        };

        let resume_opt = match raw_args.get("resumeFromRunId") {
            None => None,
            Some(Value::String(s)) => {
                let trimmed = s.trim();
                assert_safe_workflow_run_id(trimmed).map_err(ToolError::InvalidArguments)?;
                Some(trimmed.to_owned())
            }
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "resumeFromRunId must be a string".to_owned(),
                ));
            }
        };

        let dry_run_opt = match raw_args.get("dryRun") {
            None => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => {
                return Err(ToolError::InvalidArguments(
                    "dryRun must be a boolean".to_owned(),
                ));
            }
        };

        let args_opt = raw_args.get("args").cloned();

        let paths = Self::registry_paths(ctx);

        match action.as_str() {
            "list" => {
                if name_opt.is_some()
                    || script_opt.is_some()
                    || scope_opt.is_some()
                    || overwrite_opt.is_some()
                    || args_opt.is_some()
                    || resume_opt.is_some()
                    || dry_run_opt.is_some()
                {
                    return Err(ToolError::InvalidArguments(
                        "list does not accept run or save fields".to_owned(),
                    ));
                }
                let snap = list_workflow_definitions(&paths).await;
                Ok(ToolOutput::Json(json!({
                    "ok": true,
                    "workflows": snap.workflows,
                    "diagnostics": snap.diagnostics,
                })))
            }
            "save" => {
                let Some(name) = name_opt else {
                    return Err(ToolError::InvalidArguments("save requires name".to_owned()));
                };
                let Some(script) = script_opt else {
                    return Err(ToolError::InvalidArguments(
                        "save requires script".to_owned(),
                    ));
                };
                let Some(scope) = scope_opt else {
                    return Err(ToolError::InvalidArguments(
                        "save requires scope".to_owned(),
                    ));
                };
                if args_opt.is_some() || resume_opt.is_some() || dry_run_opt.is_some() {
                    return Err(ToolError::InvalidArguments(
                        "args, resumeFromRunId, and dryRun are only valid for action=run"
                            .to_owned(),
                    ));
                }
                Self::assert_can_mutate_workflow(ctx)?;
                let saved = save_workflow_definition(
                    &paths,
                    &name,
                    scope,
                    &script,
                    overwrite_opt.unwrap_or(false),
                )
                .await
                .map_err(ToolError::Execution)?;
                Ok(ToolOutput::Json(json!({
                    "ok": true,
                    "saved": saved,
                })))
            }
            _ => {
                let source_count =
                    usize::from(name_opt.is_some()) + usize::from(script_opt.is_some());
                if source_count != 1 {
                    return Err(ToolError::InvalidArguments(
                        "run requires exactly one of name or script".to_owned(),
                    ));
                }
                if scope_opt.is_some() || overwrite_opt.is_some() {
                    return Err(ToolError::InvalidArguments(
                        "scope and overwrite are only valid for action=save".to_owned(),
                    ));
                }
                let dry_run = dry_run_opt.unwrap_or(false);
                if dry_run && resume_opt.is_some() {
                    return Err(ToolError::InvalidArguments(
                        "dryRun cannot resume from a prior journal".to_owned(),
                    ));
                }

                let control = ctx.agent_control.clone().ok_or_else(|| {
                    ToolError::Execution(
                        "workflow tool requires root session agentControl".to_owned(),
                    )
                })?;

                let resolved_def = if let Some(ref name) = name_opt {
                    Some(
                        resolve_workflow_definition_for_execution(&paths, name)
                            .await
                            .map_err(ToolError::Execution)?,
                    )
                } else {
                    None
                };

                let script = resolved_def
                    .as_ref()
                    .map(|d| d.source.clone())
                    .or(script_opt)
                    .ok_or_else(|| {
                        ToolError::InvalidArguments(
                            "workflow run input validation failed".to_owned(),
                        )
                    })?;

                if !dry_run {
                    Self::assert_can_mutate_workflow(ctx)?;
                }

                let outcome = run_workflow(WorkflowRunOptions {
                    ctx: ctx.clone(),
                    control,
                    script,
                    args: args_opt,
                    resume_from_run_id: resume_opt,
                    dry_run,
                    run_timeout_ms: None,
                    max_memory_bytes: None,
                    expected_name: resolved_def.as_ref().map(|d| d.name.clone()),
                })
                .await
                .map_err(ToolError::Execution)?;

                match outcome {
                    WorkflowRunOutcome::CompileFailure(issues) => Ok(ToolOutput::Json(json!({
                        "ok": false,
                        "error": "the workflow script did not compile",
                        "issues": issues,
                    }))),
                    WorkflowRunOutcome::Success(summary) => {
                        let mut out = serde_json::to_value(&summary)
                            .ok()
                            .and_then(|v| v.as_object().cloned())
                            .unwrap_or_default();
                        out.insert("ok".to_owned(), Value::Bool(true));
                        if let Some(def) = resolved_def {
                            out.insert(
                                "definition".to_owned(),
                                json!({
                                    "name": def.name,
                                    "scope": def.scope,
                                    "path": def.path,
                                }),
                            );
                        }
                        Ok(ToolOutput::Json(Value::Object(out)))
                    }
                }
            }
        }
    }
}
