use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use cowork_inference::ToolDefinition;
use cowork_storage::SessionKind;
use futures::stream::{self, StreamExt};
use serde_json::{Map, Value, json};

use crate::bash::BashTool;
use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};
use crate::fs_tools::{EditTool, ReadTool, WriteTool};
use crate::interactive::{AskUserQuestionTool, SkillTool, TodoWriteTool};
use crate::memory::{ManageMemoryTool, MemoryTool, ReadPastConversationTool, RecallMemoryTool};
use crate::search_tools::{GlobTool, GrepTool};
use crate::thread_tools::ThreadManagementTool;
use crate::web::{WebFetchTool, WebSearchTool};

pub const MAX_PARALLEL_READ_BATCH: usize = 4;

pub type ToolMap = BTreeMap<String, Arc<dyn BuiltinTool>>;

pub fn create_builtin_tools(ctx: &ToolExecutionContext) -> ToolMap {
    let mut map: ToolMap = BTreeMap::new();
    let mut register = |tool: Arc<dyn BuiltinTool>| {
        map.insert(tool.name().to_owned(), tool);
    };

    register(Arc::new(BashTool));
    register(Arc::new(ReadTool));
    if !ctx.read_only_role {
        register(Arc::new(WriteTool));
        register(Arc::new(EditTool));
    }
    register(Arc::new(GlobTool));
    register(Arc::new(GrepTool));
    register(Arc::new(WebFetchTool));
    register(Arc::new(WebSearchTool));
    register(Arc::new(AskUserQuestionTool));
    register(Arc::new(TodoWriteTool));
    register(Arc::new(SkillTool));

    if ctx.advanced_memory {
        register(Arc::new(RecallMemoryTool));
        if !ctx.read_only_role {
            register(Arc::new(ManageMemoryTool));
        }
        register(Arc::new(ReadPastConversationTool));
    } else {
        register(Arc::new(MemoryTool));
    }

    if ctx.session_kind == SessionKind::Root && ctx.thread_control.is_some() {
        for t in ThreadManagementTool::all_tools() {
            register(t);
        }
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
            let result = match tools.get(&call.tool_name) {
                Some(tool) => tool.execute(call.arguments.clone(), ctx).await,
                None => Err(ToolError::InvalidArguments(format!(
                    "Unknown tool '{}'",
                    call.tool_name
                ))),
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
                        let output = match tool_opt {
                            Some(tool) => tool.execute(call.arguments.clone(), ctx).await,
                            None => Err(ToolError::InvalidArguments(format!(
                                "Unknown tool '{}'",
                                call.tool_name
                            ))),
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
                    "description": "Keywords or tool name to search for (leave empty to browse available tools)."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 30,
                    "description": "Maximum number of matching tools to return (default: 8)."
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
            .trim()
            .to_ascii_lowercase();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(8)
            .clamp(1, 30) as usize;
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;

        let terms: Vec<&str> = query.split_whitespace().filter(|t| !t.is_empty()).collect();

        let mut scored: Vec<(usize, &Arc<dyn BuiltinTool>)> = Vec::new();
        for tool in self.tools.values() {
            if terms.is_empty() {
                scored.push((1, tool));
                continue;
            }
            let name_lc = tool.name().to_ascii_lowercase();
            let desc_lc = tool.description().to_ascii_lowercase();
            let mut score = 0usize;
            for term in &terms {
                if name_lc == *term {
                    score += 100;
                } else if name_lc.contains(term) {
                    score += 40;
                }
                if desc_lc.contains(term) {
                    score += 10;
                }
            }
            if score > 0 {
                scored.push((score, tool));
            }
        }

        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name().cmp(b.1.name())));
        let total = scored.len();
        let page: Vec<&Arc<dyn BuiltinTool>> = scored
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, t)| t)
            .collect();

        let discovered_names: Vec<String> = page.iter().map(|t| t.name().to_owned()).collect();
        let entries: Vec<Value> = page
            .into_iter()
            .map(|t| {
                json!({
                    "name": t.name(),
                    "description": t.description(),
                    "inputSchema": t.input_schema(),
                })
            })
            .collect();

        Ok(ToolSearchResult {
            value: json!({
                "total": total,
                "offset": offset,
                "limit": limit,
                "tools": entries,
            }),
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
        tool.execute(inner_args, ctx).await
    }
}
