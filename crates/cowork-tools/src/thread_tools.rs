use std::sync::Arc;

use async_trait::async_trait;
use cowork_storage::SessionKind;
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};

fn assert_root_session_bridge(
    ctx: &ToolExecutionContext,
) -> ToolResult<&Arc<dyn crate::context::ThreadControlBridge>> {
    if ctx.session_kind != SessionKind::Root {
        return Err(ToolError::PathDenied(
            "Thread management tools are restricted to root sessions.".to_owned(),
        ));
    }
    ctx.thread_control
        .as_ref()
        .ok_or_else(|| ToolError::Execution("Thread management bridge is not attached.".to_owned()))
}

/// TS `fork_thread` has no turn cutoff (its input schema is strict and has no
/// `fromTurnIndex`): a fork always copies the source thread's whole history. The argument is
/// rejected rather than ignored so a caller never gets a different fork than it asked for.
pub const FORK_FROM_TURN_INDEX_UNSUPPORTED: &str = "fork_thread does not support fromTurnIndex: \
     a fork always copies the source thread's full history. Omit fromTurnIndex.";

pub struct ThreadManagementTool {
    tool_name: &'static str,
    desc: &'static str,
    schema: Value,
    read_only: bool,
}

impl ThreadManagementTool {
    pub fn all_tools() -> Vec<Arc<dyn BuiltinTool>> {
        vec![
            Arc::new(Self {
                tool_name: "list_projects",
                desc: "List known workspaces/projects across persisted threads.",
                schema: json!({ "type": "object", "properties": {} }),
                read_only: true,
            }),
            Arc::new(Self {
                tool_name: "list_threads",
                desc: "List recent local Cowork threads across known projects and managed one-off chats (pass cwd to narrow to one workspace). Archived threads are hidden unless matched by query or includeArchived is true; pinned threads sort first.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "cwd": { "type": "string" },
                        "includeArchived": { "type": "boolean" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                        "query": { "type": "string", "minLength": 1 }
                    }
                }),
                read_only: true,
            }),
            Arc::new(Self {
                tool_name: "read_thread",
                desc: "Read a compact, paginated transcript for a Cowork thread without subscribing to live updates. Tool outputs are omitted unless includeOutputs is true.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string", "minLength": 1 },
                        "cursor": { "type": "string", "minLength": 1 },
                        "includeOutputs": { "type": "boolean" },
                        "maxOutputCharsPerItem": { "type": "integer", "minimum": 1, "maximum": 20000 },
                        "turnLimit": { "type": "integer", "minimum": 1, "maximum": 50 }
                    },
                    "required": ["threadId"]
                }),
                read_only: true,
            }),
            Arc::new(Self {
                tool_name: "create_thread",
                desc: "Create a new Cowork thread in a local directory or isolated git worktree, start the prompt in the background, and return the new thread summary.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
                        "cwd": { "type": "string" },
                        "title": { "type": "string" },
                        "model": { "type": "string" },
                        "environment": { "type": "string", "enum": ["local", "worktree"] },
                        "branchName": { "type": "string" }
                    },
                    "required": ["prompt"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "send_message_to_thread",
                desc: "Start a turn on another thread with a prompt message.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "message": { "type": "string" }
                    },
                    "required": ["threadId", "message"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "fork_thread",
                desc: "Fork an existing thread (optionally into a fresh git worktree).",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "title": { "type": "string" },
                        "environment": { "type": "string", "enum": ["local", "worktree"] },
                        "branchName": { "type": "string" }
                    },
                    "required": ["threadId"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "set_thread_title",
                desc: "Rename an existing thread.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "title": { "type": "string" }
                    },
                    "required": ["threadId", "title"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "set_thread_pinned",
                desc: "Pin or unpin a thread.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "pinned": { "type": "boolean" }
                    },
                    "required": ["threadId", "pinned"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "set_thread_archived",
                desc: "Archive or unarchive a thread.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "archived": { "type": "boolean" }
                    },
                    "required": ["threadId", "archived"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "threadManagement",
                desc: "Manage projects and threads (list_projects, list_threads, read_thread, create_thread, send_message_to_thread, fork_thread, set_thread_title, set_thread_pinned, set_thread_archived).",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": [
                                "list_projects",
                                "list_threads",
                                "read_thread",
                                "create_thread",
                                "send_message_to_thread",
                                "fork_thread",
                                "set_thread_title",
                                "set_thread_pinned",
                                "set_thread_archived"
                            ]
                        },
                        "threadId": { "type": "string" },
                        "cwd": { "type": "string" },
                        "title": { "type": "string" },
                        "message": { "type": "string" },
                        "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
                        "model": { "type": "string" },
                        "pinned": { "type": "boolean" },
                        "archived": { "type": "boolean" },
                        "includeArchived": { "type": "boolean" },
                        "query": { "type": "string", "minLength": 1 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                        "cursor": { "type": "string", "minLength": 1 },
                        "includeOutputs": { "type": "boolean" },
                        "maxOutputCharsPerItem": { "type": "integer", "minimum": 1, "maximum": 20000 },
                        "turnLimit": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "environment": { "type": "string", "enum": ["local", "worktree"] },
                        "branchName": { "type": "string" }
                    },
                    "required": ["action"]
                }),
                read_only: false,
            }),
        ]
    }
}

#[async_trait]
impl BuiltinTool for ThreadManagementTool {
    fn name(&self) -> &str {
        self.tool_name
    }

    fn description(&self) -> &str {
        self.desc
    }

    fn input_schema(&self) -> Value {
        self.schema.clone()
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        if self.read_only {
            ToolExecutionPolicy::ParallelRead
        } else {
            ToolExecutionPolicy::Sequential
        }
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let bridge = assert_root_session_bridge(ctx)?;
        if raw_args.get("fromTurnIndex").is_some_and(|v| !v.is_null()) {
            return Err(ToolError::InvalidArguments(
                FORK_FROM_TURN_INDEX_UNSUPPORTED.to_owned(),
            ));
        }
        let args = normalize_and_validate_args(&self.schema, &raw_args)?;
        let dispatch_name = if self.tool_name == "threadManagement" {
            args.get("action")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::InvalidArguments("action is required".to_owned()))?
        } else {
            self.tool_name
        };

        let val_args = Value::Object(args.clone());
        let res = match dispatch_name {
            "list_projects" => bridge.list_projects().await,
            "list_threads" => bridge.list_threads(val_args).await,
            "read_thread" => bridge.read_thread(val_args).await,
            "create_thread" => bridge.create_thread(val_args).await,
            "send_message_to_thread" => bridge.send_message_to_thread(val_args).await,
            "fork_thread" => bridge.fork_thread(val_args).await,
            "set_thread_title" => bridge.set_thread_title(val_args).await,
            "set_thread_pinned" => bridge.set_thread_pinned(val_args).await,
            "set_thread_archived" => bridge.set_thread_archived(val_args).await,
            other => Err(format!("Unsupported threadManagement action '{other}'")),
        }
        .map_err(ToolError::Execution)?;

        Ok(ToolOutput::Json(res))
    }
}
