use std::sync::Arc;

use async_trait::async_trait;
use cowork_sandbox::{SandboxPolicy, policy_allows_network};
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

/// TS `send_message_to_thread` takes the follow-up text as `prompt`; earlier Rust builds named
/// it `message`. `message` stays accepted as a deprecated alias: it is folded into `prompt`
/// (and removed) so everything downstream reads `prompt` only. Both may be given only when
/// they carry the same text; conflicting values are rejected rather than silently picking one.
pub fn resolve_send_message_prompt_alias(args: &mut Map<String, Value>) -> Result<(), String> {
    let message = args.remove("message").filter(|v| !v.is_null());
    let Some(message) = message else {
        return Ok(());
    };
    match args.get("prompt").filter(|v| !v.is_null()) {
        None => {
            args.insert("prompt".to_owned(), message);
            Ok(())
        }
        Some(prompt) => {
            let same = match (prompt.as_str(), message.as_str()) {
                (Some(p), Some(m)) => p.trim() == m.trim(),
                _ => prompt == &message,
            };
            if same {
                Ok(())
            } else {
                Err(SEND_MESSAGE_PROMPT_CONFLICT.to_owned())
            }
        }
    }
}

pub const SEND_MESSAGE_PROMPT_CONFLICT: &str = "send_message_to_thread received both prompt and \
     message with different text. Pass prompt only (message is a deprecated alias for prompt).";

/// Actions whose omitted `threadId` defaults to the calling thread, as TS's
/// `ThreadManagementService.createControl` does via `resolveThreadId`.
pub const THREAD_ID_DEFAULTS_TO_CURRENT: &[&str] = &[
    "read_thread",
    "send_message_to_thread",
    "fork_thread",
    "set_thread_title",
    "set_thread_pinned",
    "set_thread_archived",
];

/// TS `threadEnvironmentSchema` (`src/tools/threadManagement.ts`), plus the legacy string
/// shorthand: `"local"` / `"worktree"`, `{ type: "local" }`, or
/// `{ type: "worktree", ref?, branchName?, startingState?: { ref?, branchName? } }`. Objects are
/// strict, so a malformed spec is rejected here instead of reaching the server bridge (whose
/// `fork_thread` drops an undecodable object and forks locally).
pub fn thread_environment_schema() -> Value {
    let non_empty = json!({ "type": "string", "minLength": 1 });
    json!({
        "anyOf": [
            { "type": "string", "enum": ["local", "worktree"] },
            {
                "type": "object",
                "properties": { "type": { "type": "string", "const": "local" } },
                "required": ["type"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": {
                    "type": { "type": "string", "const": "worktree" },
                    "ref": non_empty,
                    "branchName": non_empty,
                    "startingState": {
                        "type": "object",
                        "properties": { "ref": non_empty, "branchName": non_empty },
                        "additionalProperties": false
                    }
                },
                "required": ["type"],
                "additionalProperties": false
            }
        ],
        "description": "\"local\" or \"worktree\", or an object: { \"type\": \"local\" } or { \"type\": \"worktree\", \"ref\"?, \"branchName\"?, \"startingState\"?: { \"ref\"?, \"branchName\"? } }."
    })
}

/// The server's `create_thread` bridge reads `environment` only as a string (plus a top-level
/// `branchName`) and creates worktrees from the default base, so an object-form spec is folded
/// into that shape here. A worktree spec carrying a base `ref` (directly or in
/// `startingState`) is rejected rather than silently created from a different base.
pub fn fold_create_thread_environment(args: &mut Map<String, Value>) -> Result<(), String> {
    let Some(Value::Object(env)) = args.get("environment") else {
        return Ok(());
    };
    let env = env.clone();
    match env.get("type").and_then(Value::as_str) {
        Some("local") => {
            args.insert("environment".to_owned(), json!("local"));
        }
        Some("worktree") => {
            let starting = env.get("startingState").and_then(Value::as_object);
            if env.get("ref").is_some() || starting.is_some_and(|s| s.get("ref").is_some()) {
                return Err(CREATE_THREAD_WORKTREE_REF_UNSUPPORTED.to_owned());
            }
            let branch = env
                .get("branchName")
                .or_else(|| starting.and_then(|s| s.get("branchName")))
                .cloned();
            if let Some(branch) = branch {
                match args.get("branchName").filter(|v| !v.is_null()) {
                    Some(existing) if existing != &branch => {
                        return Err(CREATE_THREAD_BRANCH_CONFLICT.to_owned());
                    }
                    _ => {
                        args.insert("branchName".to_owned(), branch);
                    }
                }
            }
            args.insert("environment".to_owned(), json!("worktree"));
        }
        _ => return Err("environment.type must be \"local\" or \"worktree\".".to_owned()),
    }
    Ok(())
}

pub const CREATE_THREAD_WORKTREE_REF_UNSUPPORTED: &str = "create_thread does not support a \
     worktree base ref: new worktrees start from the workspace's current HEAD. Omit ref.";

pub const CREATE_THREAD_BRANCH_CONFLICT: &str = "create_thread received different branchName \
     values in environment and at the top level. Pass one.";

/// Thread actions that only read server state.
const READ_ONLY_THREAD_ACTIONS: &[&str] = &["list_projects", "list_threads", "read_thread"];

/// Thread actions that start a model turn in another thread (a new root thread, a fork, or a
/// follow-up on an existing thread). That turn runs under the target thread's own sandbox, so
/// these are withheld from sessions confined more tightly than a default root turn.
const TURN_STARTING_THREAD_ACTIONS: &[&str] =
    &["create_thread", "fork_thread", "send_message_to_thread"];

/// Why this session may not run the mutating thread action `action`, or `None` when it may.
///
/// TS gated the whole tool set on scope only (`!agentRole && !taskContext && !scopedChild`); the
/// Rust port additionally refuses mutating actions from sessions that cannot write the project
/// (read-only role, `read-only` / `no-project-write` sandbox), and turn-starting actions from
/// sessions without network access, because `create_thread` / `fork_thread` /
/// `send_message_to_thread` run a new turn under the target thread's (default
/// `workspace-write` + network) sandbox and `read_thread` returns its result, escaping this
/// session's floor.
pub fn thread_action_denial(ctx: &ToolExecutionContext, action: &str) -> Option<String> {
    if ctx.in_task_context {
        return Some("Thread management tools are unavailable inside a task.".to_owned());
    }
    if ctx.target_paths.as_ref().is_some_and(|t| !t.is_empty()) {
        return Some(
            "Thread management tools are unavailable to path-scoped (targetPaths) sessions."
                .to_owned(),
        );
    }
    if READ_ONLY_THREAD_ACTIONS.contains(&action) {
        return None;
    }
    let cannot_write = ctx.read_only_role
        || matches!(
            ctx.sandbox_policy,
            SandboxPolicy::ReadOnly { .. } | SandboxPolicy::NoProjectWrite { .. }
        );
    if cannot_write {
        let mode = if ctx.read_only_role {
            "a read-only role"
        } else {
            ctx.sandbox_policy.kind_str()
        };
        return Some(format!(
            "{action} is blocked: this session runs under {mode} and may not modify threads or start turns in them."
        ));
    }
    if TURN_STARTING_THREAD_ACTIONS.contains(&action) && !policy_allows_network(&ctx.sandbox_policy)
    {
        return Some(format!(
            "{action} is blocked: this session's sandbox has network access disabled, and the started turn would not be."
        ));
    }
    None
}

pub struct ThreadManagementTool {
    tool_name: &'static str,
    desc: &'static str,
    schema: Value,
    read_only: bool,
}

impl ThreadManagementTool {
    /// The thread tools this session may call: per-action tools whose action
    /// [`thread_action_denial`] refuses are withheld, while the combined `threadManagement`
    /// tool stays (its read actions remain usable; refused actions fail at execution).
    pub fn tools_for(ctx: &ToolExecutionContext) -> Vec<Arc<dyn BuiltinTool>> {
        Self::all_tools()
            .into_iter()
            .filter(|tool| {
                tool.name() == "threadManagement"
                    || thread_action_denial(ctx, tool.name()).is_none()
            })
            .collect()
    }

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
                desc: "Read a compact, paginated transcript for a Cowork thread without subscribing to live updates. Tool outputs are omitted unless includeOutputs is true. Defaults to the current thread when threadId is omitted.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string", "minLength": 1 },
                        "cursor": { "type": "string", "minLength": 1 },
                        "includeOutputs": { "type": "boolean" },
                        "maxOutputCharsPerItem": { "type": "integer", "minimum": 1, "maximum": 20000 },
                        "turnLimit": { "type": "integer", "minimum": 1, "maximum": 50 }
                    }
                }),
                read_only: true,
            }),
            Arc::new(Self {
                tool_name: "create_thread",
                desc: "Create a new Cowork thread in a known project workspace or managed one-off chat (cwd defaults to the server workspace), optionally in an isolated git worktree of it, start the prompt in the background, and return the new thread summary.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
                        "cwd": { "type": "string" },
                        "title": { "type": "string" },
                        "model": { "type": "string" },
                        "thinking": { "type": "string", "minLength": 1 },
                        "environment": thread_environment_schema(),
                        "branchName": { "type": "string" }
                    },
                    "required": ["prompt"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "send_message_to_thread",
                desc: "Send a follow-up user message (prompt) to an idle Cowork thread, optionally switching its model and/or reasoning level (thinking) first. Busy threads return queued=false/busy=true rather than being steered; nothing is applied to them. Defaults to the current thread when threadId is omitted.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
                        "model": { "type": "string" },
                        "thinking": { "type": "string", "minLength": 1 }
                    },
                    "required": ["prompt"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "fork_thread",
                desc: "Fork an existing thread into a new root thread (optionally into a fresh git worktree), optionally on a different model and/or reasoning level (thinking), and optionally start a prompt on the fork in the background. Defaults to the current thread when threadId is omitted.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "title": { "type": "string" },
                        "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
                        "model": { "type": "string" },
                        "thinking": { "type": "string", "minLength": 1 },
                        "environment": thread_environment_schema(),
                        "branchName": { "type": "string" }
                    }
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "set_thread_title",
                desc: "Rename a thread. Defaults to the current thread when threadId is omitted.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "title": { "type": "string" }
                    },
                    "required": ["title"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "set_thread_pinned",
                desc: "Pin or unpin a thread. Defaults to the current thread when threadId is omitted.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "pinned": { "type": "boolean" }
                    },
                    "required": ["pinned"]
                }),
                read_only: false,
            }),
            Arc::new(Self {
                tool_name: "set_thread_archived",
                desc: "Archive or unarchive a thread. Defaults to the current thread when threadId is omitted.",
                schema: json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string" },
                        "archived": { "type": "boolean" }
                    },
                    "required": ["archived"]
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
                        "prompt": { "type": "string", "minLength": 1, "maxLength": 100000 },
                        "model": { "type": "string" },
                        "thinking": { "type": "string", "minLength": 1 },
                        "pinned": { "type": "boolean" },
                        "archived": { "type": "boolean" },
                        "includeArchived": { "type": "boolean" },
                        "query": { "type": "string", "minLength": 1 },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
                        "cursor": { "type": "string", "minLength": 1 },
                        "includeOutputs": { "type": "boolean" },
                        "maxOutputCharsPerItem": { "type": "integer", "minimum": 1, "maximum": 20000 },
                        "turnLimit": { "type": "integer", "minimum": 1, "maximum": 50 },
                        "environment": thread_environment_schema(),
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
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let bridge = assert_root_session_bridge(ctx)?;
        if raw_args.get("fromTurnIndex").is_some_and(|v| !v.is_null()) {
            return Err(ToolError::InvalidArguments(
                FORK_FROM_TURN_INDEX_UNSUPPORTED.to_owned(),
            ));
        }
        let is_send = if self.tool_name == "threadManagement" {
            raw_args.get("action").and_then(Value::as_str) == Some("send_message_to_thread")
        } else {
            self.tool_name == "send_message_to_thread"
        };
        if is_send {
            resolve_send_message_prompt_alias(&mut raw_args)
                .map_err(ToolError::InvalidArguments)?;
        }
        let mut args = normalize_and_validate_args(&self.schema, &raw_args)?;
        let dispatch_name = if self.tool_name == "threadManagement" {
            args.get("action")
                .and_then(Value::as_str)
                .ok_or_else(|| ToolError::InvalidArguments("action is required".to_owned()))?
                .to_owned()
        } else {
            self.tool_name.to_owned()
        };
        // Scope and sandbox are rechecked here, not only at registration: the registry may have
        // been built for a different context than the one executing (code mode, deferred
        // catalogs), and `threadManagement` multiplexes read and mutating actions.
        if let Some(denial) = thread_action_denial(ctx, &dispatch_name) {
            return Err(ToolError::PathDenied(denial));
        }
        if dispatch_name == "create_thread" {
            fold_create_thread_environment(&mut args).map_err(ToolError::InvalidArguments)?;
        }
        // TS `ThreadManagementService.createControl(currentThreadId)`: an omitted `threadId`
        // on `fork_thread` and the title/pinned/archived setters resolves to the calling
        // thread (this tool's session).
        if THREAD_ID_DEFAULTS_TO_CURRENT.contains(&dispatch_name.as_str())
            && !args.contains_key("threadId")
        {
            args.insert("threadId".to_owned(), Value::String(ctx.session_id.clone()));
        }

        let val_args = Value::Object(args.clone());
        let res = match dispatch_name.as_str() {
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
