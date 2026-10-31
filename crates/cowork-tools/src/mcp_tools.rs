use std::sync::Arc;

use async_trait::async_trait;
use cowork_mcp::{LoadedMcpTool, McpToolErrorEntry};
use serde_json::{Map, Value, json};

use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};

pub const DEFAULT_TOOL_SEARCH_LIMIT: usize = 5;
pub const MAX_TOOL_SEARCH_LIMIT: usize = 20;

#[derive(Debug, Clone)]
pub struct SearchableToolEntry {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Splits camelCase, kebab-case, snake_case, and whitespace into lowercase alphanumeric tokens.
pub fn tokenize_search_text(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;

    for ch in input.chars() {
        if ch.is_alphanumeric() {
            let is_upper = ch.is_uppercase();
            if is_upper && prev_lower && !current.is_empty() {
                tokens.push(current.to_lowercase());
                current.clear();
            }
            current.push(ch);
            prev_lower = ch.is_lowercase();
        } else {
            if !current.is_empty() {
                tokens.push(current.to_lowercase());
                current.clear();
            }
            prev_lower = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current.to_lowercase());
    }
    tokens
}

/// Scores and paginates a catalog of tools using TS `toolCatalog.ts` camelCase-aware token scoring:
/// - Exact full-name match ranks first
/// - `+20` exact name token, `+10` substring name token, `+4` exact description token, `+1` substring description token
/// - Ties break alphabetically by `name`.
pub fn score_and_paginate_tools(
    items: &[SearchableToolEntry],
    raw_query: &str,
    limit: usize,
    offset: usize,
    errors: &[McpToolErrorEntry],
) -> (Value, Vec<String>) {
    let trimmed = raw_query.trim();
    let is_wildcard = trimmed.is_empty() || trimmed == "*";
    let query_lc = trimmed.to_lowercase();
    let query_tokens = if is_wildcard {
        Vec::new()
    } else {
        tokenize_search_text(trimmed)
    };

    let mut matches: Vec<(bool, usize, &SearchableToolEntry)> = Vec::new();
    for item in items {
        if is_wildcard {
            matches.push((false, 1, item));
            continue;
        }
        let name_lc = item.name.to_lowercase();
        let exact = name_lc == query_lc;
        let name_tokens = tokenize_search_text(&item.name);
        let desc_tokens = tokenize_search_text(&item.description);

        let mut score = if exact { 1_000usize } else { 0usize };
        for qt in &query_tokens {
            if name_tokens.iter().any(|nt| nt == qt) {
                score += 20;
            } else if name_lc.contains(qt) || name_tokens.iter().any(|nt| nt.contains(qt)) {
                score += 10;
            }
            if desc_tokens.iter().any(|dt| dt == qt) {
                score += 4;
            } else if desc_tokens.iter().any(|dt| dt.contains(qt)) {
                score += 1;
            }
        }
        if score > 0 {
            matches.push((exact, score, item));
        }
    }

    matches.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.name.cmp(&b.2.name))
    });

    let total = matches.len();
    let page: Vec<&SearchableToolEntry> = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(_, _, item)| item)
        .collect();

    let discovered: Vec<String> = page.iter().map(|i| i.name.clone()).collect();
    let tool_entries: Vec<Value> = page
        .into_iter()
        .map(|i| {
            json!({
                "name": i.name,
                "description": i.description,
                "inputSchema": i.input_schema,
            })
        })
        .collect();

    let mut out = json!({
        "tools": tool_entries,
        "total": total,
        "offset": offset,
        "limit": limit,
    });
    if offset + discovered.len() < total {
        out["nextOffset"] = json!(offset + discovered.len());
    }
    if !errors.is_empty() {
        out["errors"] = json!(errors);
    }

    (out, discovered)
}

fn filter_mcp_tools_for_context(
    tools: &[LoadedMcpTool],
    ctx: &ToolExecutionContext,
) -> Vec<LoadedMcpTool> {
    if ctx.read_only_role {
        // Read-only subagent roles cannot invoke external mutating MCP tools
        return Vec::new();
    }
    match &ctx.allowed_mcp_servers {
        None => tools.to_vec(),
        Some(allowed) => tools
            .iter()
            .filter(|t| allowed.contains(&t.server_name))
            .cloned()
            .collect(),
    }
}

/// Standard-mode `toolSearch` backed by `WorkspaceMcpToolCache`.
pub struct McpToolSearchTool;

#[async_trait]
impl BuiltinTool for McpToolSearchTool {
    fn name(&self) -> &str {
        "toolSearch"
    }

    fn description(&self) -> &str {
        "Search configured MCP server tools by keyword or '*' wildcard to inspect their names and JSON parameter schemas before calling mcpCall."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 1000,
                    "description": "Keywords, tool name, or '*' to list available MCP tools."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20,
                    "description": "Maximum number of matching MCP tools to return (default: 5, max: 20)."
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Pagination offset (default: 0)."
                }
            },
            "required": ["query"]
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
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("query is required".to_owned()))?
            .trim();
        if query.is_empty() {
            return Err(ToolError::InvalidArguments(
                "query must not be empty (pass '*' to list all MCP tools)".to_owned(),
            ));
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TOOL_SEARCH_LIMIT as u64)
            .clamp(1, MAX_TOOL_SEARCH_LIMIT as u64) as usize;
        let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;

        let (Some(cache), Some(cfg)) = (&ctx.mcp_tool_cache, &ctx.agent_config) else {
            let (val, _) = score_and_paginate_tools(&[], query, limit, offset, &[]);
            return Ok(ToolOutput::Json(val));
        };

        let ctx_clone = ctx.clone();
        let query_owned = query.to_owned();
        let val = cache
            .with_tools(cfg, &ctx.env, &ctx.session_id, move |tools, errors| {
                let filtered = filter_mcp_tools_for_context(tools, &ctx_clone);
                let searchable: Vec<SearchableToolEntry> = filtered
                    .into_iter()
                    .map(|t| SearchableToolEntry {
                        name: t.qualified_name,
                        description: t.description,
                        input_schema: t.input_schema,
                    })
                    .collect();
                let errs = errors.to_vec();
                Box::pin(async move {
                    let (v, _) =
                        score_and_paginate_tools(&searchable, &query_owned, limit, offset, &errs);
                    v
                })
            })
            .await
            .map_err(ToolError::Execution)?;

        Ok(ToolOutput::Json(val))
    }
}

/// Standard-mode `mcpCall` backed by `WorkspaceMcpToolCache`.
pub struct McpCallTool;

#[async_trait]
impl BuiltinTool for McpCallTool {
    fn name(&self) -> &str {
        "mcpCall"
    }

    fn description(&self) -> &str {
        "Invoke a discovered MCP tool by its qualified name (e.g. 'mcp__server__tool') and JSON arguments object."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "tool": {
                    "type": "string",
                    "description": "Qualified MCP tool name discovered via toolSearch (e.g. 'mcp__server__tool')."
                },
                "arguments": {
                    "type": "object",
                    "description": "JSON arguments matching the MCP tool's inputSchema."
                }
            },
            "required": ["tool"]
        })
    }

    async fn execute(
        &self,
        mut raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "MCP tool calls are blocked because this session is running in read-only mode."
                    .to_owned(),
            ));
        }
        if !raw_args.contains_key("tool")
            && let Some(alias) = raw_args.remove("name")
        {
            raw_args.insert("tool".to_owned(), alias);
        }
        let args = normalize_and_validate_args(&self.input_schema(), &raw_args)?;
        let target_tool = args
            .get("tool")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("tool is required".to_owned()))?
            .trim()
            .to_owned();
        if target_tool.is_empty() {
            return Err(ToolError::InvalidArguments(
                "tool must not be empty".to_owned(),
            ));
        }
        let call_args = args
            .get("arguments")
            .and_then(Value::as_object)
            .cloned()
            .map(Value::Object)
            .unwrap_or_else(|| json!({}));

        let (Some(cache), Some(cfg)) = (&ctx.mcp_tool_cache, &ctx.agent_config) else {
            return Err(ToolError::Execution(
                "MCP is not enabled for this session.".to_owned(),
            ));
        };

        let ctx_clone = ctx.clone();
        let target_clone = target_tool.clone();
        let res = cache
            .with_tools(cfg, &ctx.env, &ctx.session_id, move |tools, _errors| {
                let filtered = filter_mcp_tools_for_context(tools, &ctx_clone);
                let found = filtered
                    .into_iter()
                    .find(|t| t.qualified_name == target_clone);
                Box::pin(async move {
                    let Some(tool_handle) = found else {
                        return Err(format!(
                            "MCP tool '{target_clone}' was not found or is not allowed. Call toolSearch first."
                        ));
                    };
                    tool_handle.call(call_args).await
                })
            })
            .await
            .map_err(ToolError::Execution)?
            .map_err(ToolError::Execution)?;

        Ok(ToolOutput::Json(res))
    }
}

/// Wraps a `LoadedMcpTool` as a `BuiltinTool` so `DeferredToolCatalog` can search and call MCP tools directly!
pub struct LoadedMcpBuiltinToolAdapter {
    tool: LoadedMcpTool,
}

impl LoadedMcpBuiltinToolAdapter {
    pub fn into_builtin(tool: LoadedMcpTool) -> Arc<dyn BuiltinTool> {
        Arc::new(Self { tool })
    }
}

#[async_trait]
impl BuiltinTool for LoadedMcpBuiltinToolAdapter {
    fn name(&self) -> &str {
        &self.tool.qualified_name
    }

    fn description(&self) -> &str {
        &self.tool.description
    }

    fn input_schema(&self) -> Value {
        self.tool.input_schema.clone()
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        if ctx.read_only_role {
            return Err(ToolError::PathDenied(
                "MCP tool calls are blocked because this session is running in read-only mode."
                    .to_owned(),
            ));
        }
        let validated = normalize_and_validate_args(&self.tool.input_schema, &raw_args)?;
        let res = self
            .tool
            .call(Value::Object(validated))
            .await
            .map_err(ToolError::Execution)?;
        Ok(ToolOutput::Json(res))
    }
}
