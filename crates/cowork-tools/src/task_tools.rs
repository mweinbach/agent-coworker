//! Built-in Task Mode tools: `createTask`, `taskUpdate`, and `reviewTask`.
//!
//! Mirrors `src/tools/createTask.ts`, `src/tools/taskUpdate.ts`, and `src/tools/taskReview.ts`.

use std::sync::OnceLock;

use async_trait::async_trait;
use cowork_storage::{
    DEFAULT_TASK_REVIEW_ROUNDS, MAX_TASK_REVIEW_ROUNDS, TaskContextSnapshot, TaskDirective,
    TaskDirectiveContinuation, TaskDirectiveQuestionInput, TaskDirectiveQuestionOptionInput,
    TaskDirectiveRequirementInput, TaskDirectiveWorkItemInput, TaskQuestionUrgency,
    TaskRequirementKind, TaskReviewRound, TaskReviewVerdict, WorkItemStatus,
    get_pending_task_review, get_task_review_rounds_for_context,
    get_task_review_rounds_from_activity, get_task_review_rounds_from_records,
    parse_and_validate_task_creation_input,
};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::context::{BuiltinTool, ToolError, ToolExecutionContext, ToolOutput, ToolResult};

// ============================================================================
// 1. createTask (`src/tools/createTask.ts`)
// ============================================================================

const CREATE_TASK_DESCRIPTION: &str = "Create a durable task and switch the current chat into task mode.\n\n\
This is a one-shot mode change. Use it only after the conversation contains enough detail to provide a complete title, objective, context handoff, acceptance criteria, and dependency-aware work plan. Ask the user only for material missing details before calling it. Load the \"task\" skill for the complete usage policy.\n\n\
After this succeeds, the current chat is locked until the task completes, fails, or is cancelled. Do not call another tool or produce a follow-up response after this call.";

pub struct CreateTaskTool;

#[async_trait]
impl BuiltinTool for CreateTaskTool {
    fn name(&self) -> &str {
        "createTask"
    }

    fn description(&self) -> &str {
        CREATE_TASK_DESCRIPTION
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "idempotencyKey": { "type": "string", "minLength": 1, "maxLength": 200 },
                "title": { "type": "string", "minLength": 1, "maxLength": 160 },
                "objective": { "type": "string", "minLength": 1 },
                "context": { "type": "string", "minLength": 1 },
                "requirements": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "kind": {
                                "type": "string",
                                "enum": ["requirement", "constraint", "acceptance_criterion"]
                            },
                            "text": { "type": "string", "minLength": 1 },
                            "permanence": {
                                "type": ["string", "null"],
                                "enum": ["fixed", "temporary", null]
                            }
                        },
                        "required": ["kind", "text"]
                    }
                },
                "workItems": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "key": { "type": "string", "minLength": 1, "maxLength": 80 },
                            "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                            "description": { "type": ["string", "null"] },
                            "dependsOn": {
                                "type": ["array", "null"],
                                "items": { "type": "string", "minLength": 1, "maxLength": 80 }
                            },
                            "expectedOutputs": {
                                "type": ["array", "null"],
                                "items": { "type": "string", "minLength": 1 }
                            }
                        },
                        "required": ["key", "title"]
                    }
                },
                "decisions": {
                    "type": ["array", "null"],
                    "items": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "question": { "type": "string", "minLength": 1 },
                            "resolution": { "type": "string", "minLength": 1 },
                            "confidence": { "type": ["number", "null"], "minimum": 0, "maximum": 1 }
                        },
                        "required": ["question", "resolution"]
                    }
                },
                "reviewRequired": { "type": ["boolean", "null"] },
                "reviewRounds": {
                    "type": ["integer", "null"],
                    "minimum": 0,
                    "maximum": MAX_TASK_REVIEW_ROUNDS,
                    "default": DEFAULT_TASK_REVIEW_ROUNDS
                }
            },
            "required": ["idempotencyKey", "title", "objective", "context", "requirements", "workItems"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let creation = parse_and_validate_task_creation_input(&Value::Object(raw_args), true)
            .map_err(|e| ToolError::InvalidArguments(format!("invalid arguments: {e}")))?;
        let bridge = ctx.task_bridge.as_ref().ok_or_else(|| {
            ToolError::Execution("Task creation handler is unavailable".to_owned())
        })?;
        let result = bridge
            .create_task(&ctx.session_id, creation)
            .await
            .map_err(ToolError::Execution)?;

        ctx.request_stop_after_step();

        let payload = json!({
            "taskId": result.task.id,
            "title": result.task.title,
            "status": result.task.status.as_str(),
            "taskThreadId": result.task.threads.first().map(|t| t.session_id.as_str()),
            "workspaceDisposition": result.workspace_disposition,
            "modeChanged": true,
        });
        Ok(ToolOutput::Text(
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_owned()),
        ))
    }
}

// ============================================================================
// 2. taskUpdate (`src/tools/taskUpdate.ts`)
// ============================================================================

const TASK_UPDATE_DESCRIPTION: &str = "Update the shared task record for this task-mode thread.\n\n\
Use this instead of chat todos. The task coordinator validates graph dependencies, work ownership, revision conflicts, artifacts, lifecycle transitions, and completion readiness.\n\n\
Use request_input only for decisions with material consequences. Batch related questions. Non-blocking questions require a reversible default and let work continue; blocking questions pause the task after this tool call.\n\n\
Use address_review only after implementing and verifying every actionable finding from that review. The implementationSummary must identify the concrete changes and verification evidence; it is not a waiver or acknowledgement-only step.\n\n\
Mutating directives require the latest task revision. The tool result returns the new revision. Use a stable unique idempotencyKey so retrying the same logical directive cannot duplicate it.";

/// Recursively strips `null` values on object fields EXCEPT inside `provenance`
/// (`omitProviderNullOptionals` in `src/tools/taskUpdate.ts`).
pub fn omit_provider_null_optionals(value: &Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.iter().map(omit_provider_null_optionals).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if v.is_null() {
                    continue;
                }
                if k == "provenance" {
                    out.insert(k.clone(), v.clone());
                } else {
                    out.insert(k.clone(), omit_provider_null_optionals(v));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn req_non_empty_str(
    obj: &Map<String, Value>,
    field: &str,
    max_len: Option<usize>,
) -> ToolResult<String> {
    let val = obj
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!("{field} must be a non-empty string"))
        })?;
    if let Some(max) = max_len
        && val.chars().count() > max
    {
        return Err(ToolError::InvalidArguments(format!(
            "{field} must be at most {max} characters"
        )));
    }
    Ok(val.to_owned())
}

fn opt_non_empty_str(obj: &Map<String, Value>, field: &str) -> ToolResult<Option<String>> {
    match obj.get(field) {
        None => Ok(None),
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Err(ToolError::InvalidArguments(format!(
                    "{field} must not be empty"
                )));
            }
            Ok(Some(trimmed.to_owned()))
        }
        _ => Err(ToolError::InvalidArguments(format!(
            "{field} must be a string"
        ))),
    }
}

fn req_nonneg_int(obj: &Map<String, Value>, field: &str) -> ToolResult<i64> {
    let n = obj
        .get(field)
        .and_then(Value::as_i64)
        .filter(|v| *v >= 0)
        .ok_or_else(|| {
            ToolError::InvalidArguments(format!("{field} must be a non-negative integer"))
        })?;
    Ok(n)
}

fn ensure_strict_keys(
    obj: &Map<String, Value>,
    allowed: &[&str],
    ctx_name: &str,
) -> ToolResult<()> {
    for k in obj.keys() {
        if !allowed.contains(&k.as_str()) {
            return Err(ToolError::InvalidArguments(format!(
                "Unrecognized key '{k}' in {ctx_name}"
            )));
        }
    }
    Ok(())
}

/// Parses and validates `taskDirectiveInputSchema` for `taskUpdate`.
/// Deliberately rejects `record_review` (which may only be submitted by `reviewTask`).
pub fn parse_task_update_directive(raw_args: &Map<String, Value>) -> ToolResult<TaskDirective> {
    let cleaned = omit_provider_null_optionals(&Value::Object(raw_args.clone()));
    let obj = cleaned
        .as_object()
        .ok_or_else(|| ToolError::InvalidArguments("Directive must be an object".to_owned()))?;

    let idempotency_key = req_non_empty_str(obj, "idempotencyKey", Some(200))?;
    let dtype = req_non_empty_str(obj, "type", None)?;

    match dtype.as_str() {
        "update_plan" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "objective",
                    "requirements",
                    "workItems",
                ],
                "update_plan",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let objective = opt_non_empty_str(obj, "objective")?;
            let requirements = match obj.get("requirements") {
                None => None,
                Some(Value::Array(arr)) => {
                    let mut out = Vec::with_capacity(arr.len());
                    for entry in arr {
                        let rmap = entry.as_object().ok_or_else(|| {
                            ToolError::InvalidArguments("requirement must be an object".to_owned())
                        })?;
                        ensure_strict_keys(rmap, &["kind", "text", "permanence"], "requirement")?;
                        let kind_raw = req_non_empty_str(rmap, "kind", None)?;
                        let kind = TaskRequirementKind::parse(&kind_raw).ok_or_else(|| {
                            ToolError::InvalidArguments(format!(
                                "Invalid requirement kind: {kind_raw}"
                            ))
                        })?;
                        let text = req_non_empty_str(rmap, "text", None)?;
                        let permanence = match opt_non_empty_str(rmap, "permanence")? {
                            None => None,
                            Some(p) if p == "fixed" || p == "temporary" => Some(p),
                            Some(other) => {
                                return Err(ToolError::InvalidArguments(format!(
                                    "Invalid permanence: {other}"
                                )));
                            }
                        };
                        out.push(TaskDirectiveRequirementInput {
                            kind,
                            text,
                            permanence,
                        });
                    }
                    Some(out)
                }
                _ => {
                    return Err(ToolError::InvalidArguments(
                        "requirements must be an array".to_owned(),
                    ));
                }
            };

            let items_arr = obj
                .get("workItems")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ToolError::InvalidArguments("workItems array is required".to_owned())
                })?;
            let mut work_items = Vec::with_capacity(items_arr.len());
            for entry in items_arr {
                let wmap = entry.as_object().ok_or_else(|| {
                    ToolError::InvalidArguments("workItem must be an object".to_owned())
                })?;
                ensure_strict_keys(
                    wmap,
                    &[
                        "id",
                        "title",
                        "description",
                        "status",
                        "dependsOn",
                        "expectedOutputs",
                    ],
                    "workItem",
                )?;
                let id = opt_non_empty_str(wmap, "id")?;
                let title = req_non_empty_str(wmap, "title", None)?;
                let description = match wmap.get("description") {
                    None => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => {
                        return Err(ToolError::InvalidArguments(
                            "description must be a string".to_owned(),
                        ));
                    }
                };
                let status = match opt_non_empty_str(wmap, "status")? {
                    None => None,
                    Some(s) => Some(WorkItemStatus::parse(&s).ok_or_else(|| {
                        ToolError::InvalidArguments(format!("Invalid work item status: {s}"))
                    })?),
                };
                let depends_on = match wmap.get("dependsOn") {
                    None => None,
                    Some(Value::Array(arr)) => {
                        let mut out = Vec::with_capacity(arr.len());
                        for v in arr {
                            let s = v
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .ok_or_else(|| {
                                    ToolError::InvalidArguments(
                                        "dependsOn entries must be non-empty strings".to_owned(),
                                    )
                                })?;
                            out.push(s.to_owned());
                        }
                        Some(out)
                    }
                    _ => {
                        return Err(ToolError::InvalidArguments(
                            "dependsOn must be an array".to_owned(),
                        ));
                    }
                };
                let expected_outputs = match wmap.get("expectedOutputs") {
                    None => None,
                    Some(Value::Array(arr)) => {
                        let mut out = Vec::with_capacity(arr.len());
                        for v in arr {
                            let s = v
                                .as_str()
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .ok_or_else(|| {
                                    ToolError::InvalidArguments(
                                        "expectedOutputs entries must be non-empty strings"
                                            .to_owned(),
                                    )
                                })?;
                            out.push(s.to_owned());
                        }
                        Some(out)
                    }
                    _ => {
                        return Err(ToolError::InvalidArguments(
                            "expectedOutputs must be an array".to_owned(),
                        ));
                    }
                };
                work_items.push(TaskDirectiveWorkItemInput {
                    id,
                    title,
                    description,
                    status,
                    depends_on,
                    expected_outputs,
                });
            }

            Ok(TaskDirective::UpdatePlan {
                idempotency_key,
                expected_revision,
                objective,
                requirements,
                work_items,
            })
        }
        "mark_work_item" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "workItemId",
                    "status",
                    "completionEvidence",
                ],
                "mark_work_item",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let work_item_id = req_non_empty_str(obj, "workItemId", None)?;
            let status_raw = req_non_empty_str(obj, "status", None)?;
            let status = WorkItemStatus::parse(&status_raw).ok_or_else(|| {
                ToolError::InvalidArguments(format!("Invalid work item status: {status_raw}"))
            })?;
            let completion_evidence = opt_non_empty_str(obj, "completionEvidence")?;
            Ok(TaskDirective::MarkWorkItem {
                idempotency_key,
                expected_revision,
                work_item_id,
                status,
                completion_evidence,
            })
        }
        "record_decision" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "question",
                    "resolution",
                    "confidence",
                    "scope",
                    "supersedes",
                ],
                "record_decision",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let question = req_non_empty_str(obj, "question", None)?;
            let resolution = req_non_empty_str(obj, "resolution", None)?;
            let confidence = match obj.get("confidence") {
                None => None,
                Some(v) => {
                    let c = v.as_f64().ok_or_else(|| {
                        ToolError::InvalidArguments("confidence must be a number".to_owned())
                    })?;
                    if !(0.0..=1.0).contains(&c) {
                        return Err(ToolError::InvalidArguments(
                            "confidence must be between 0 and 1".to_owned(),
                        ));
                    }
                    Some(c)
                }
            };
            let scope = match opt_non_empty_str(obj, "scope")? {
                None => None,
                Some(s) if s == "task" || s == "project" => Some(s),
                Some(other) => {
                    return Err(ToolError::InvalidArguments(format!(
                        "Invalid scope: {other}"
                    )));
                }
            };
            let supersedes = opt_non_empty_str(obj, "supersedes")?;
            Ok(TaskDirective::RecordDecision {
                idempotency_key,
                expected_revision,
                question,
                resolution,
                confidence,
                scope,
                supersedes,
            })
        }
        "report_progress" => {
            ensure_strict_keys(
                obj,
                &["idempotencyKey", "type", "summary", "detail", "workItemId"],
                "report_progress",
            )?;
            let summary = req_non_empty_str(obj, "summary", None)?;
            let detail = match obj.get("detail") {
                None => None,
                Some(Value::String(s)) => Some(s.clone()),
                _ => {
                    return Err(ToolError::InvalidArguments(
                        "detail must be a string".to_owned(),
                    ));
                }
            };
            let work_item_id = opt_non_empty_str(obj, "workItemId")?;
            Ok(TaskDirective::ReportProgress {
                idempotency_key,
                summary,
                detail,
                work_item_id,
            })
        }
        "request_input" => {
            ensure_strict_keys(
                obj,
                &["idempotencyKey", "type", "expectedRevision", "questions"],
                "request_input",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let q_arr = obj
                .get("questions")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ToolError::InvalidArguments("questions must be an array".to_owned())
                })?;
            if q_arr.is_empty() || q_arr.len() > 3 {
                return Err(ToolError::InvalidArguments(
                    "questions must contain 1 to 3 items".to_owned(),
                ));
            }
            let mut questions = Vec::with_capacity(q_arr.len());
            for entry in q_arr {
                let qmap = entry.as_object().ok_or_else(|| {
                    ToolError::InvalidArguments("question must be an object".to_owned())
                })?;
                ensure_strict_keys(
                    qmap,
                    &[
                        "header",
                        "question",
                        "context",
                        "blocking",
                        "urgency",
                        "defaultAction",
                        "options",
                        "recommendedOptionId",
                        "workItemId",
                        "supersedes",
                    ],
                    "question",
                )?;
                let header = req_non_empty_str(qmap, "header", Some(40))?;
                let question = req_non_empty_str(qmap, "question", None)?;
                let context = match qmap.get("context") {
                    None => None,
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => {
                        return Err(ToolError::InvalidArguments(
                            "context must be a string".to_owned(),
                        ));
                    }
                };
                let blocking = qmap
                    .get("blocking")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        ToolError::InvalidArguments("blocking must be a boolean".to_owned())
                    })?;
                let urgency_raw = req_non_empty_str(qmap, "urgency", None)?;
                let urgency = TaskQuestionUrgency::parse(&urgency_raw).ok_or_else(|| {
                    ToolError::InvalidArguments(format!("Invalid urgency: {urgency_raw}"))
                })?;
                let default_action = opt_non_empty_str(qmap, "defaultAction")?;
                let options = match qmap.get("options") {
                    None => None,
                    Some(Value::Array(oarr)) => {
                        if oarr.len() < 2 || oarr.len() > 3 {
                            return Err(ToolError::InvalidArguments(
                                "options must contain 2 to 3 items".to_owned(),
                            ));
                        }
                        let mut opts = Vec::with_capacity(oarr.len());
                        for oentry in oarr {
                            let omap = oentry.as_object().ok_or_else(|| {
                                ToolError::InvalidArguments("option must be an object".to_owned())
                            })?;
                            ensure_strict_keys(omap, &["id", "label", "description"], "option")?;
                            let id = req_non_empty_str(omap, "id", None)?;
                            let label = req_non_empty_str(omap, "label", None)?;
                            let description = match omap.get("description") {
                                None => None,
                                Some(Value::String(s)) => Some(s.clone()),
                                _ => {
                                    return Err(ToolError::InvalidArguments(
                                        "option.description must be a string".to_owned(),
                                    ));
                                }
                            };
                            opts.push(TaskDirectiveQuestionOptionInput {
                                id,
                                label,
                                description,
                            });
                        }
                        Some(opts)
                    }
                    _ => {
                        return Err(ToolError::InvalidArguments(
                            "options must be an array".to_owned(),
                        ));
                    }
                };
                let recommended_option_id = opt_non_empty_str(qmap, "recommendedOptionId")?;
                let work_item_id = opt_non_empty_str(qmap, "workItemId")?;
                let supersedes = opt_non_empty_str(qmap, "supersedes")?;
                questions.push(TaskDirectiveQuestionInput {
                    header,
                    question,
                    context,
                    blocking,
                    urgency,
                    default_action,
                    options,
                    recommended_option_id,
                    work_item_id,
                    supersedes,
                });
            }
            Ok(TaskDirective::RequestInput {
                idempotency_key,
                expected_revision,
                questions,
            })
        }
        "report_blocker" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "description",
                    "blocking",
                    "workItemId",
                ],
                "report_blocker",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let description = req_non_empty_str(obj, "description", None)?;
            let blocking = obj
                .get("blocking")
                .and_then(Value::as_bool)
                .ok_or_else(|| {
                    ToolError::InvalidArguments("blocking must be a boolean".to_owned())
                })?;
            let work_item_id = opt_non_empty_str(obj, "workItemId")?;
            Ok(TaskDirective::ReportBlocker {
                idempotency_key,
                expected_revision,
                description,
                blocking,
                work_item_id,
            })
        }
        "register_artifact" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "path",
                    "title",
                    "kind",
                    "artifactId",
                    "baseVersionId",
                    "changeSummary",
                    "workItemId",
                    "provenance",
                ],
                "register_artifact",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let path = req_non_empty_str(obj, "path", None)?;
            let title = req_non_empty_str(obj, "title", None)?;
            let kind = req_non_empty_str(obj, "kind", None)?;
            let artifact_id = opt_non_empty_str(obj, "artifactId")?;
            let base_version_id = opt_non_empty_str(obj, "baseVersionId")?;
            let change_summary = opt_non_empty_str(obj, "changeSummary")?;
            let work_item_id = opt_non_empty_str(obj, "workItemId")?;
            let provenance = match obj.get("provenance") {
                None => None,
                Some(Value::Object(m)) => Some(m.clone()),
                _ => {
                    return Err(ToolError::InvalidArguments(
                        "provenance must be an object".to_owned(),
                    ));
                }
            };
            Ok(TaskDirective::RegisterArtifact {
                idempotency_key,
                expected_revision,
                path,
                title,
                kind,
                artifact_id,
                base_version_id,
                change_summary,
                work_item_id,
                provenance,
            })
        }
        "address_review" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "reviewId",
                    "implementationSummary",
                ],
                "address_review",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let review_id = req_non_empty_str(obj, "reviewId", None)?;
            let implementation_summary = req_non_empty_str(obj, "implementationSummary", None)?;
            Ok(TaskDirective::AddressReview {
                idempotency_key,
                expected_revision,
                review_id,
                implementation_summary,
            })
        }
        "propose_completion" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "summary",
                    "caveats",
                ],
                "propose_completion",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let summary = req_non_empty_str(obj, "summary", None)?;
            let caveats = match obj.get("caveats") {
                None => None,
                Some(Value::Array(arr)) => {
                    let mut out = Vec::with_capacity(arr.len());
                    for v in arr {
                        let s = v
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| {
                                ToolError::InvalidArguments(
                                    "caveats entries must be non-empty strings".to_owned(),
                                )
                            })?;
                        out.push(s.to_owned());
                    }
                    Some(out)
                }
                _ => {
                    return Err(ToolError::InvalidArguments(
                        "caveats must be an array".to_owned(),
                    ));
                }
            };
            Ok(TaskDirective::ProposeCompletion {
                idempotency_key,
                expected_revision,
                summary,
                caveats,
            })
        }
        "create_thread" => {
            ensure_strict_keys(
                obj,
                &[
                    "idempotencyKey",
                    "type",
                    "expectedRevision",
                    "title",
                    "workItemId",
                ],
                "create_thread",
            )?;
            let expected_revision = req_nonneg_int(obj, "expectedRevision")?;
            let title = req_non_empty_str(obj, "title", None)?;
            let work_item_id = req_non_empty_str(obj, "workItemId", None)?;
            Ok(TaskDirective::CreateThread {
                idempotency_key,
                expected_revision,
                title,
                work_item_id,
            })
        }
        other => Err(ToolError::InvalidArguments(format!(
            "Invalid taskUpdate directive type: {other}"
        ))),
    }
}

pub struct TaskUpdateTool;

#[async_trait]
impl BuiltinTool for TaskUpdateTool {
    fn name(&self) -> &str {
        "taskUpdate"
    }

    fn description(&self) -> &str {
        TASK_UPDATE_DESCRIPTION
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "idempotencyKey": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200,
                    "description": "Stable unique key for this logical directive; reuse it only when retrying the same operation"
                },
                "type": {
                    "type": "string",
                    "enum": [
                        "update_plan",
                        "mark_work_item",
                        "record_decision",
                        "report_progress",
                        "request_input",
                        "report_blocker",
                        "register_artifact",
                        "address_review",
                        "propose_completion",
                        "create_thread"
                    ]
                },
                "expectedRevision": { "type": "integer", "minimum": 0 },
                "objective": { "type": "string" },
                "requirements": { "type": "array", "items": { "type": "object" } },
                "workItems": { "type": "array", "items": { "type": "object" } },
                "workItemId": { "type": "string" },
                "status": {
                    "type": "string",
                    "enum": ["queued", "in_progress", "blocked", "review", "done", "abandoned"]
                },
                "completionEvidence": { "type": "string" },
                "question": { "type": "string" },
                "resolution": { "type": "string" },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "scope": { "type": "string", "enum": ["task", "project"] },
                "supersedes": { "type": "string" },
                "summary": { "type": "string" },
                "detail": { "type": "string" },
                "questions": { "type": "array", "items": { "type": "object" } },
                "description": { "type": "string" },
                "blocking": { "type": "boolean" },
                "path": { "type": "string" },
                "title": { "type": "string" },
                "kind": { "type": "string" },
                "artifactId": { "type": "string" },
                "baseVersionId": { "type": "string" },
                "changeSummary": { "type": "string" },
                "provenance": { "type": "object" },
                "reviewId": { "type": "string" },
                "implementationSummary": { "type": "string" },
                "caveats": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["idempotencyKey", "type"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let directive = parse_task_update_directive(&raw_args)?;
        let bridge = ctx.task_bridge.as_ref().ok_or_else(|| {
            ToolError::Execution("Task directive handler is unavailable".to_owned())
        })?;
        let result = bridge
            .apply_task_directive(&ctx.session_id, directive)
            .await
            .map_err(ToolError::Execution)?;

        if result.continuation == TaskDirectiveContinuation::PauseForInput {
            ctx.request_stop_after_step();
        }

        let task = &result.task;
        let payload = json!({
            "taskId": task.id,
            "status": task.status.as_str(),
            "revision": task.revision,
            "completedWorkItems": task.completed_work_item_count,
            "totalWorkItems": task.total_work_item_count,
            "activeBlockers": task.active_blocker_count,
            "pendingQuestions": task.pending_question_count,
            "blockingQuestions": task.blocking_question_count,
            "continuation": result.continuation.as_str(),
        });
        Ok(ToolOutput::Text(
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_owned()),
        ))
    }
}

// ============================================================================
// 3. reviewTask (`src/tools/taskReview.ts`)
// ============================================================================

const TASK_REVIEW_DESCRIPTION: &str = "Run the next required independent task review round with a separate read-only reviewer agent.\n\n\
Use this only after all work items and expected artifacts are complete and registered. The reviewer inspects actual deliverables, tests acceptance criteria, probes for shallow or incomplete work, and records a durable verdict. A FAIL or PARTIAL verdict must be implemented and verified, then acknowledged with taskUpdate address_review before another round. The configured review count is a minimum: after it is met, run additional rounds when material uncertainty, risky changes, or prior findings justify more assurance, up to the safety cap. Do not call propose_completion until every required round is recorded.";

fn render_review_briefing(
    context: &TaskContextSnapshot,
    reviews: &[TaskReviewRound],
    focus: Option<&str>,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("Task: {}", context.title));
    lines.push(format!("Objective: {}", context.objective));
    if !context.context.is_empty() {
        lines.push(format!("Context: {}", context.context));
    }
    lines.push("Acceptance requirements:".to_owned());
    for req in context.requirements.iter().filter(|r| r.status == "active") {
        lines.push(format!("- [{}] {}", req.kind.as_str(), req.text));
    }
    lines.push("Work evidence:".to_owned());
    for item in &context.work_items {
        lines.push(format!(
            "- [{}] {}: {}",
            item.status.as_str(),
            item.title,
            item.completion_evidence
                .as_deref()
                .unwrap_or("no completion evidence")
        ));
    }
    lines.push("Registered artifacts (inspect these directly):".to_owned());
    for artifact in &context.artifacts {
        lines.push(format!("- {}: {}", artifact.title, artifact.path));
    }
    if !reviews.is_empty() {
        lines.push("Prior independent reviews and implementation responses:".to_owned());
        for rev in reviews {
            lines.push(format!(
                "- Round {} {}: {}",
                rev.round,
                rev.verdict.as_str().to_ascii_uppercase(),
                rev.feedback
            ));
            if let Some(imp) = &rev.implementation_summary {
                lines.push(format!("  Implemented response: {imp}"));
            }
        }
    }
    if let Some(f) = focus {
        lines.push(format!("Requested review focus: {f}"));
    }
    lines.join("\n")
}

fn render_review_prompt(round: i64, required_rounds: i64, focus: Option<&str>) -> String {
    let mut paragraphs = vec![
        format!(
            "Perform independent quality review round {round}. The task requires at least {required_rounds} round(s); rounds beyond that minimum are deliberate additional assurance."
        ),
        "Inspect the actual registered deliverables and relevant source material. Do not accept the primary agent's completion claims as evidence.".to_owned(),
        "Evaluate correctness, completeness, every acceptance criterion, edge and failure cases, data or formula integrity, and user-facing usability/polish where applicable.".to_owned(),
        "Actively look for shallow work: placeholders, unsupported assertions, missing scenarios, skipped validation, superficial formatting, and shortcuts that technically exist but do not satisfy the intent.".to_owned(),
        "Run concrete verification and at least one adversarial probe. If prior feedback has an implemented response, verify the implementation itself rather than trusting its summary.".to_owned(),
        "Stay read-only. Give prioritized, actionable findings with precise evidence and finish with VERDICT: PASS, VERDICT: PARTIAL, or VERDICT: FAIL.".to_owned(),
    ];
    if let Some(f) = focus {
        paragraphs.push(format!("Pay particular attention to: {f}"));
    }
    paragraphs.join("\n\n")
}

pub fn parse_reviewer_verdict(feedback: &str) -> Result<TaskReviewVerdict, String> {
    static VERDICT_RE: OnceLock<Regex> = OnceLock::new();
    let re = VERDICT_RE
        .get_or_init(|| Regex::new(r"(?i)VERDICT:\s*(PASS|PARTIAL|FAIL)\b").expect("valid regex"));
    let last = re
        .captures_iter(feedback)
        .last()
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_ascii_lowercase());
    match last.as_deref() {
        Some("pass") => Ok(TaskReviewVerdict::Pass),
        Some("partial") => Ok(TaskReviewVerdict::Partial),
        Some("fail") => Ok(TaskReviewVerdict::Fail),
        _ => Err("Reviewer did not provide a valid PASS, PARTIAL, or FAIL verdict".to_owned()),
    }
}

pub struct ReviewTaskTool;

#[async_trait]
impl BuiltinTool for ReviewTaskTool {
    fn name(&self) -> &str {
        "reviewTask"
    }

    fn description(&self) -> &str {
        TASK_REVIEW_DESCRIPTION
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "expectedRevision": { "type": "integer", "minimum": 0 },
                "focus": { "type": "string", "minLength": 1 },
                "model": { "type": "string", "minLength": 1 }
            },
            "required": ["expectedRevision"]
        })
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let mut cleaned = Map::new();
        for (k, v) in raw_args {
            if !v.is_null() {
                cleaned.insert(k, v);
            }
        }
        ensure_strict_keys(
            &cleaned,
            &["expectedRevision", "focus", "model"],
            "reviewTask",
        )?;
        let expected_revision = req_nonneg_int(&cleaned, "expectedRevision")?;
        let focus = opt_non_empty_str(&cleaned, "focus")?;
        let model = opt_non_empty_str(&cleaned, "model")?;

        let task_bridge = ctx
            .task_bridge
            .as_ref()
            .ok_or_else(|| ToolError::Execution("Task context is unavailable".to_owned()))?;
        let agent_control = ctx.agent_control.as_ref().ok_or_else(|| {
            ToolError::Execution("Child agents are unavailable in this session.".to_owned())
        })?;

        let context = task_bridge
            .get_task_context(&ctx.session_id)
            .ok_or_else(|| ToolError::Execution("Task context is unavailable".to_owned()))?;
        if context.revision != expected_revision {
            return Err(ToolError::Execution(format!(
                "Task revision conflict: expected {expected_revision}, current {}",
                context.revision
            )));
        }
        let required_rounds = context.review_rounds.unwrap_or(0);
        if required_rounds == 0 {
            return Err(ToolError::Execution(
                "This task does not require independent reviews".to_owned(),
            ));
        }
        let prior_rounds = get_task_review_rounds_for_context(&context);
        if let Some(pending) = get_pending_task_review(&prior_rounds) {
            return Err(ToolError::Execution(format!(
                "Review round {} feedback must be implemented and addressed first",
                pending.round
            )));
        }
        if prior_rounds.len() as i64 >= MAX_TASK_REVIEW_ROUNDS {
            return Err(ToolError::Execution(format!(
                "Task reached the {MAX_TASK_REVIEW_ROUNDS}-round review safety cap"
            )));
        }

        let round = prior_rounds.len() as i64 + 1;
        let requested_model = model.or_else(|| {
            ctx.agent_config.as_ref().and_then(|cfg| {
                Some(cfg.preferred_child_model_ref.trim())
                    .filter(|s| !s.is_empty())
                    .or_else(|| Some(cfg.preferred_child_model.trim()).filter(|s| !s.is_empty()))
                    .map(str::to_owned)
            })
        });

        let reviewed_material = task_bridge
            .get_task_review_material(&ctx.session_id)
            .await
            .map_err(ToolError::Execution)?;

        let mut spawn_args = json!({
            "message": render_review_prompt(round, required_rounds, focus.as_deref()),
            "role": "reviewer",
            "nickname": format!("task-review-{round}"),
            "taskType": "verify",
            "contextMode": "brief",
            "briefing": render_review_briefing(&context, &prior_rounds, focus.as_deref()),
        });
        if let Some(m) = requested_model {
            spawn_args["model"] = Value::String(m);
        }

        let spawned = agent_control
            .spawn_agent(&ctx.session_id, spawn_args)
            .await
            .map_err(ToolError::Execution)?;

        let reviewer_agent_id = spawned
            .get("agentId")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::Execution("Spawned reviewer missing agentId".to_owned()))?
            .to_owned();
        let reviewer_provider = spawned
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("openai")
            .to_owned();
        let reviewer_model = spawned
            .get("effectiveModel")
            .and_then(Value::as_str)
            .unwrap_or(&ctx.model)
            .to_owned();

        let run_result: Result<Value, String> = async {
            let waited = agent_control
                .wait_for_agent(
                    &ctx.session_id,
                    json!({
                        "agentIds": [&reviewer_agent_id],
                        "timeoutMs": 600_000,
                        "mode": "all",
                        "includeFinalMessage": true,
                        "includeReport": true,
                    }),
                )
                .await?;

            if waited.get("timedOut").and_then(Value::as_bool) == Some(true) {
                return Err(format!("Reviewer {reviewer_agent_id} timed out"));
            }

            let errored_ids: Vec<&str> = waited
                .get("erroredAgentIds")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let settled = waited
                .get("agents")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter().find(|a| {
                        a.get("agentId").and_then(Value::as_str) == Some(&reviewer_agent_id)
                    })
                });
            let exec_state = settled
                .and_then(|a| a.get("executionState"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let is_busy = settled
                .and_then(|a| a.get("busy"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if exec_state != "completed"
                || is_busy
                || errored_ids.contains(&reviewer_agent_id.as_str())
            {
                return Err(format!(
                    "Reviewer {reviewer_agent_id} did not complete successfully ({exec_state})"
                ));
            }

            let feedback = waited
                .get("inspections")
                .and_then(Value::as_array)
                .and_then(|arr| {
                    arr.iter().find(|i| {
                        i.get("agentId").and_then(Value::as_str) == Some(&reviewer_agent_id)
                    })
                })
                .and_then(|i| i.get("latestAssistantText"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("Reviewer {reviewer_agent_id} returned no critique"))?
                .to_owned();

            let verdict = parse_reviewer_verdict(&feedback)?;
            let dir_result = task_bridge
                .apply_task_directive(
                    &ctx.session_id,
                    TaskDirective::RecordReview {
                        idempotency_key: format!("review:{}:{reviewer_agent_id}", context.id),
                        expected_revision,
                        expected_material_fingerprint: Some(reviewed_material.fingerprint),
                        reviewer_agent_id: reviewer_agent_id.clone(),
                        reviewer_provider,
                        reviewer_model,
                        verdict,
                        feedback,
                    },
                )
                .await?;

            let recorded_rounds = if let Some(revs) = &dir_result.reviews {
                get_task_review_rounds_from_records(revs)
            } else {
                get_task_review_rounds_from_activity(&dir_result.task.activity)
            };
            let recorded = recorded_rounds
                .last()
                .filter(|r| r.reviewer_agent_id == reviewer_agent_id)
                .ok_or_else(|| {
                    "Recorded review could not be read from the task review state".to_owned()
                })?;

            Ok(json!({
                "reviewId": recorded.review_id,
                "round": recorded.round,
                "verdict": recorded.verdict.as_str(),
                "feedback": recorded.feedback,
                "requiresImplementation": recorded.verdict != TaskReviewVerdict::Pass,
                "requiredRounds": required_rounds,
                "taskRevision": dir_result.task.revision,
            }))
        }
        .await;

        let _ = agent_control
            .close_agent(&ctx.session_id, json!({ "agentId": reviewer_agent_id }))
            .await;

        let out = run_result.map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(out))
    }
}
