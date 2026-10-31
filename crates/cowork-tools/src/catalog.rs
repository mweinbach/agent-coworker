use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use cowork_inference::ToolDefinition;
use cowork_storage::SessionKind;
use futures::stream::{self, StreamExt};
use serde_json::{Map, Value, json};

use crate::agent_tools::all_subagent_tools;
use crate::bash::BashTool;
use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};
use crate::fs_tools::{EditTool, ReadTool, WriteTool};
use crate::interactive::{AskUserQuestionTool, SkillTool, TodoWriteTool};
use crate::mcp_tools::{
    McpCallTool, McpToolSearchTool, SearchableToolEntry, score_and_paginate_tools,
};
use crate::memory::{ManageMemoryTool, MemoryTool, ReadPastConversationTool, RecallMemoryTool};
use crate::search_tools::{GlobTool, GrepTool};
use crate::task_tools::{CreateTaskTool, ReviewTaskTool, TaskUpdateTool};
use crate::thread_tools::ThreadManagementTool;
use crate::web::{WebFetchTool, WebSearchTool};

pub const MAX_PARALLEL_READ_BATCH: usize = 4;

pub type ToolMap = BTreeMap<String, Arc<dyn BuiltinTool>>;

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
    register(Arc::new(WebSearchTool));
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
        for t in ThreadManagementTool::all_tools() {
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
        && !ctx.read_only_role
        && ctx
            .allowed_mcp_servers
            .as_ref()
            .is_none_or(|s| !s.is_empty());

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
    }

    if let Some(allowed) = &ctx.allowed_builtin_tools {
        map.retain(|name, _| name == "toolSearch" || name == "mcpCall" || allowed.contains(name));
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

/// Executes contiguous runs of `ParallelRead` tools (such as `glob`, `grep`, `read`)
/// concurrently up to `MAX_PARALLEL_READ_BATCH = 4` while preserving exact call order,
/// and executes `Sequential` tools strictly one at a time.
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
            let result = match ctx.check_before_tool_invocation(&call.tool_name) {
                Err(err) => Err(err),
                Ok(()) => match tools.get(&call.tool_name) {
                    Some(tool) => tool.execute(call.arguments.clone(), ctx).await,
                    None => Err(ToolError::InvalidArguments(format!(
                        "Unknown tool '{}'",
                        call.tool_name
                    ))),
                },
            };
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
                        let output = match ctx.check_before_tool_invocation(&call.tool_name) {
                            Err(err) => Err(err),
                            Ok(()) => match tool_opt {
                                Some(tool) => tool.execute(call.arguments.clone(), ctx).await,
                                None => Err(ToolError::InvalidArguments(format!(
                                    "Unknown tool '{}'",
                                    call.tool_name
                                ))),
                            },
                        };
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
    pub fn new(tools: ToolMap) -> Self {
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

    pub fn active_tool_definitions(&self, activated: &BTreeSet<String>) -> Vec<ToolDefinition> {
        let mut defs = self.initial_tool_definitions();
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
        ctx.check_before_tool_invocation(target_name)?;
        tool.execute(inner_args, ctx).await
    }
}
