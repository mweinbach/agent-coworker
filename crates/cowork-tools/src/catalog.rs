use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use cowork_config::ProviderName;
use cowork_inference::ToolDefinition;
use cowork_storage::SessionKind;
use futures::stream::{self, StreamExt};
use serde_json::{Map, Value, json};

use crate::agent_tools::all_subagent_tools;
use crate::bash::BashTool;
use crate::code_mode_tool::{
    CODE_MODE_DESCRIPTION, CatalogToolSearchTool, CodeModeTool, is_reserved_code_mode_tool,
};
use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};
use crate::fs_tools::{EditTool, ReadTool, WriteTool};
use crate::interactive::{AskUserQuestionTool, SkillTool, TodoWriteTool};
use crate::mcp_tools::{
    McpCallTool, McpToolSearchTool, SearchableToolEntry, mcp_access_enabled,
    score_and_paginate_tools,
};
use crate::memory::{ManageMemoryTool, MemoryTool, ReadPastConversationTool, RecallMemoryTool};
use crate::search_tools::{GlobTool, GrepTool};
use crate::task_tools::{CreateTaskTool, ReviewTaskTool, TaskUpdateTool};
use crate::thread_tools::ThreadManagementTool;
use crate::web::{WebFetchTool, WebSearchTool};
use crate::workflow::WorkflowTool;

use cowork_config::web_search_options::{
    codex_web_search_backend, google_native_web_search_enabled,
};

pub const MAX_PARALLEL_READ_BATCH: usize = 4;

pub type ToolMap = BTreeMap<String, Arc<dyn BuiltinTool>>;

/// TS `createTools`' `includeLegacyWebSearch` (`src/tools/index.ts`): the custom Exa/Parallel
/// `webSearch` tool is omitted when Gemini's native Google Search is active, and for
/// `codex-cli` unless its web-search backend is a local one (`exa` / `parallel`), since the
/// native backend (the default) already searches.
pub fn includes_custom_web_search(ctx: &ToolExecutionContext) -> bool {
    match ctx.provider {
        ProviderName::Google => !google_native_web_search_enabled(Some(&ctx.provider_options)),
        ProviderName::CodexCli => {
            codex_web_search_backend(Some(&ctx.provider_options)).unwrap_or("native") != "native"
        }
        _ => true,
    }
}

pub fn create_builtin_tools(ctx: &ToolExecutionContext) -> ToolMap {
    let mut map: ToolMap = BTreeMap::new();
    let mut register = |tool: Arc<dyn BuiltinTool>| {
        map.insert(tool.name().to_owned(), tool);
    };

    let has_target_paths = ctx
        .target_paths
        .as_ref()
        .is_some_and(|paths| !paths.is_empty());

    // Scoped child agents (`targetPaths` set) do NOT receive `bash`
    if !has_target_paths {
        register(Arc::new(BashTool));
    }
    register(Arc::new(ReadTool));
    if !ctx.read_only_role {
        register(Arc::new(WriteTool));
        register(Arc::new(EditTool));
    }
    register(Arc::new(GlobTool));
    register(Arc::new(GrepTool));
    register(Arc::new(WebFetchTool));
    if includes_custom_web_search(ctx) {
        register(Arc::new(WebSearchTool));
    }
    if !ctx.in_task_context && ctx.can_ask_user && ctx.session_kind == SessionKind::Root {
        register(Arc::new(AskUserQuestionTool));
    }
    if ctx.in_task_context && ctx.task_bridge.is_some() {
        register(Arc::new(TaskUpdateTool));
    } else {
        register(Arc::new(TodoWriteTool));
    }
    if ctx.in_task_context
        && ctx.task_bridge.is_some()
        && ctx.agent_control.is_some()
        && !ctx.read_only_role
        && !has_target_paths
    {
        register(Arc::new(ReviewTaskTool));
    }
    if !ctx.in_task_context
        && ctx.session_kind == SessionKind::Root
        && !ctx.read_only_role
        && !has_target_paths
        && ctx.task_bridge.is_some()
        && ctx.agent_config.as_ref().is_some_and(|c| c.tasks_enabled)
    {
        register(Arc::new(CreateTaskTool));
    }
    register(Arc::new(SkillTool));

    // Memory tools are withheld when `targetPaths` confines the child agent
    let enable_memory = ctx
        .agent_config
        .as_ref()
        .map(|c| c.enable_memory)
        .unwrap_or(true);
    if !has_target_paths && enable_memory {
        if ctx.advanced_memory {
            register(Arc::new(RecallMemoryTool));
            if !ctx.read_only_role {
                register(Arc::new(ManageMemoryTool));
            }
            register(Arc::new(ReadPastConversationTool));
        } else {
            register(Arc::new(MemoryTool));
        }
    }

    if !ctx.in_task_context
        && ctx.session_kind == SessionKind::Root
        && ctx.thread_control.is_some()
        && !has_target_paths
    {
        // Read-only thread actions stay available; mutating / turn-starting ones are withheld
        // from sessions that cannot write or have no network (`thread_action_denial`).
        for t in ThreadManagementTool::tools_for(ctx) {
            register(t);
        }
    }

    // Standard-mode MCP tools (`toolSearch` + `mcpCall`) when `enable_mcp` is active and not in `deferred_tool_search` mode
    let deferred_mode = ctx
        .agent_config
        .as_ref()
        .is_some_and(|c| c.tool_calling.deferred_tool_search);
    let mcp_enabled = ctx
        .agent_config
        .as_ref()
        .map(|c| c.enable_mcp)
        .unwrap_or(false)
        && ctx.mcp_tool_cache.is_some()
        && mcp_access_enabled(ctx);

    if mcp_enabled && !deferred_mode {
        register(Arc::new(McpToolSearchTool));
        register(Arc::new(McpCallTool));
    }

    // Apply role/profile built-in tool filter BEFORE registering root-only subagent tools,
    // or filter subagent tools too if an explicit allowlist is present.
    if ctx.session_kind == SessionKind::Root && ctx.agent_control.is_some() && !has_target_paths {
        for agent_tool in all_subagent_tools() {
            register(agent_tool);
        }
        if !ctx.in_task_context
            && ctx
                .agent_config
                .as_ref()
                .is_some_and(|c| c.workflows_enabled)
        {
            register(Arc::new(WorkflowTool));
        }
    }

    if let Some(allowed) = &ctx.allowed_builtin_tools {
        map.retain(|name, _| name == "toolSearch" || name == "mcpCall" || allowed.contains(name));
    }

    let code_mode_enabled = ctx
        .agent_config
        .as_ref()
        .is_some_and(|c| c.tool_calling.code_mode);
    if code_mode_enabled && !deferred_mode {
        let mut base = map.clone();
        base.remove("toolSearch");
        base.remove("mcpCall");
        base.remove("toolCall");
        base.remove("codeMode");
        let cat = DeferredToolCatalog::new(base);
        let search_tool: Arc<dyn BuiltinTool> =
            Arc::new(CatalogToolSearchTool::new(cat.clone(), None));
        let cm_tool: Arc<dyn BuiltinTool> = Arc::new(CodeModeTool::new(cat, None));
        map.insert(search_tool.name().to_owned(), search_tool);
        map.insert(cm_tool.name().to_owned(), cm_tool);
    }

    map
}

#[derive(Debug, Clone)]
pub struct ToolBatchCall {
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Map<String, Value>,
}

#[derive(Debug)]
pub struct ToolBatchResult {
    pub call_id: String,
    pub tool_name: String,
    pub output: ToolResult<ToolOutput>,
}

pub type ParallelTestHook = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// Result text for a tool call skipped because the turn was cancelled (Stop) before it started.
/// Matches the harness's synthesized result for calls that never ran, so every `tool_use` in an
/// interrupted transcript is answered the same way.
pub const TOOL_CALL_ABORTED_MESSAGE: &str = "Tool call was not executed: the turn was interrupted.";

/// TS `signal?.throwIfAborted()` in `wrapToolWithMutationGate`: refuse to start a tool once the
/// turn is cancelled.
pub fn ensure_not_cancelled(ctx: &ToolExecutionContext) -> ToolResult<()> {
    if ctx.is_cancelled() {
        return Err(ToolError::Execution(TOOL_CALL_ABORTED_MESSAGE.to_owned()));
    }
    Ok(())
}

async fn invoke_batch_call(
    tool: Option<&Arc<dyn BuiltinTool>>,
    call: &ToolBatchCall,
    ctx: &ToolExecutionContext,
) -> ToolResult<ToolOutput> {
    // Checked per call (not per batch): many tools never poll cancellation themselves, so a
    // Stop during an earlier call must keep later side-effecting calls from starting.
    ensure_not_cancelled(ctx)?;
    ctx.check_before_tool_invocation(&call.tool_name)?;
    match tool {
        Some(tool) => tool.execute(call.arguments.clone(), ctx).await,
        None => Err(ToolError::InvalidArguments(format!(
            "Unknown tool '{}'",
            call.tool_name
        ))),
    }
}

/// Executes contiguous runs of `ParallelRead` tools (such as `glob`, `grep`, `read`)
/// concurrently up to `MAX_PARALLEL_READ_BATCH = 4` while preserving exact call order,
/// and executes `Sequential` tools strictly one at a time. Every call gets a result; calls not yet
/// started when the turn is cancelled get [`TOOL_CALL_ABORTED_MESSAGE`] without executing.
pub async fn execute_tool_batch(
    tools: &ToolMap,
    calls: &[ToolBatchCall],
    ctx: &ToolExecutionContext,
    parallel_hook: Option<ParallelTestHook>,
) -> Vec<ToolBatchResult> {
    let mut out = Vec::with_capacity(calls.len());
    let mut idx = 0usize;

    while idx < calls.len() {
        let is_parallel = tools
            .get(&calls[idx].tool_name)
            .is_some_and(|t| t.execution_policy() == ToolExecutionPolicy::ParallelRead);

        if !is_parallel {
            let call = &calls[idx];
            let result = invoke_batch_call(tools.get(&call.tool_name), call, ctx).await;
            out.push(ToolBatchResult {
                call_id: call.call_id.clone(),
                tool_name: call.tool_name.clone(),
                output: result,
            });
            idx += 1;
            continue;
        }

        let start = idx;
        while idx < calls.len()
            && tools
                .get(&calls[idx].tool_name)
                .is_some_and(|t| t.execution_policy() == ToolExecutionPolicy::ParallelRead)
        {
            idx += 1;
        }
        let slice = &calls[start..idx];

        let mut indexed_results: Vec<(usize, ToolBatchResult)> =
            stream::iter(slice.iter().cloned().enumerate())
                .map(|(offset, call)| {
                    let tool_opt = tools.get(&call.tool_name).cloned();
                    let hook_clone = parallel_hook.clone();
                    async move {
                        if let Some(h) = hook_clone {
                            h().await;
                        }
                        let output = invoke_batch_call(tool_opt.as_ref(), &call, ctx).await;
                        (
                            offset,
                            ToolBatchResult {
                                call_id: call.call_id,
                                tool_name: call.tool_name,
                                output,
                            },
                        )
                    }
                })
                .buffer_unordered(MAX_PARALLEL_READ_BATCH)
                .collect()
                .await;

        indexed_results.sort_by_key(|(offset, _)| *offset);
        for (_, res) in indexed_results {
            out.push(res);
        }
    }

    out
}

pub struct ToolSearchResult {
    pub value: Value,
    pub discovered_names: Vec<String>,
}

/// Cross-provider `deferredToolSearch` (`toolSearch` + `toolCall`), exposing a minimal
/// 2-tool surface initially and dynamically activating discovered tools on subsequent steps.
#[derive(Clone)]
pub struct DeferredToolCatalog {
    tools: ToolMap,
}

impl DeferredToolCatalog {
    pub fn new(mut tools: ToolMap) -> Self {
        tools.retain(|name, _| !is_reserved_code_mode_tool(name));
        Self { tools }
    }

    pub fn inner_tools(&self) -> &ToolMap {
        &self.tools
    }

    pub fn tool_search_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "maxLength": 1000,
                    "description": "Keywords, tool name, or '*' to search for (leave empty or '*' to browse available tools)."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "description": "Maximum number of matching tools to return (default: 5, max: 20)."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Pagination offset (default: 0)."
                }
            }
        })
    }

    pub fn tool_call_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Exact tool name discovered via toolSearch."
                },
                "arguments": {
                    "type": "object",
                    "description": "Arguments object matching the target tool's inputSchema."
                }
            },
            "required": ["name"]
        })
    }

    pub fn initial_tool_definitions(&self) -> Vec<ToolDefinition> {
        vec![
            ToolDefinition {
                name: "toolSearch".to_owned(),
                description: "Search the deferred tool catalog by keyword or name to inspect parameter schemas and activate tools.".to_owned(),
                parameters: Self::tool_search_schema(),
            },
            ToolDefinition {
                name: "toolCall".to_owned(),
                description: "Invoke any tool from the catalog by name and arguments object.".to_owned(),
                parameters: Self::tool_call_schema(),
            },
        ]
    }

    pub fn active_tool_definitions_with_code_mode(
        &self,
        activated: &BTreeSet<String>,
        include_code_mode: bool,
    ) -> Vec<ToolDefinition> {
        let mut defs = self.initial_tool_definitions();
        if include_code_mode {
            defs.push(ToolDefinition {
                name: "codeMode".to_owned(),
                description: CODE_MODE_DESCRIPTION.to_owned(),
                parameters: CodeModeTool::code_mode_input_schema(
                    cowork_js_vm::CodeModeLimits::default().max_source_bytes,
                ),
            });
        }
        for name in activated {
            if let Some(tool) = self.tools.get(name) {
                defs.push(tool.definition());
            }
        }
        defs
    }

    pub fn execute_tool_search(
        &self,
        raw_args: &Map<String, Value>,
    ) -> ToolResult<ToolSearchResult> {
        let args = normalize_and_validate_args(&Self::tool_search_schema(), raw_args)?;
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(5)
            .clamp(1, 20) as usize;
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;

        let searchable: Vec<SearchableToolEntry> = self
            .tools
            .values()
            .map(|t| SearchableToolEntry {
                name: t.name().to_owned(),
                description: t.description().to_owned(),
                input_schema: t.input_schema(),
            })
            .collect();

        let (value, discovered_names) =
            score_and_paginate_tools(&searchable, query, limit, offset, &[]);
        Ok(ToolSearchResult {
            value,
            discovered_names,
        })
    }

    pub async fn execute_tool_call(
        &self,
        raw_args: &Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let args = normalize_and_validate_args(&Self::tool_call_schema(), raw_args)?;
        let target_name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("name is required".to_owned()))?;
        let inner_args = args
            .get("arguments")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();

        let tool = self.tools.get(target_name).ok_or_else(|| {
            ToolError::InvalidArguments(format!(
                "Tool '{target_name}' does not exist in catalog. Call toolSearch first."
            ))
        })?;
        ensure_not_cancelled(ctx)?;
        ctx.check_before_tool_invocation(target_name)?;
        tool.execute(inner_args, ctx).await
    }
}
