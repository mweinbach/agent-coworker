use std::collections::BTreeSet;
use std::sync::Arc;

use async_trait::async_trait;
use cowork_js_vm::{
    CodeModeCatalog, CodeModeExecutionResult, CodeModeLimits, CodeModeOptions, execute_code_mode,
};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::catalog::DeferredToolCatalog;
use crate::context::{
    BuiltinTool, ToolError, ToolExecutionContext, ToolExecutionPolicy, ToolOutput, ToolResult,
    normalize_and_validate_args,
};

pub const CODE_MODE_DESCRIPTION: &str = "Execute a bounded async JavaScript/TypeScript body with tools.search(query) and tools.call(name, arguments). Return JSON data. No filesystem, shell, network, or import access exists except through permitted tools.";

const RESERVED_TOOL_NAMES: &[&str] = &["toolSearch", "toolCall", "codeMode", "prototype"];

pub fn is_reserved_code_mode_tool(name: &str) -> bool {
    RESERVED_TOOL_NAMES.contains(&name)
}

/// Read-only `toolSearch` built-in backed by a `DeferredToolCatalog` (used when `codeMode` is
/// active without `deferredToolSearch`, or whenever direct catalog search is exposed).
pub struct CatalogToolSearchTool {
    catalog: DeferredToolCatalog,
    activated: Option<Arc<Mutex<BTreeSet<String>>>>,
}

impl CatalogToolSearchTool {
    pub fn new(
        catalog: DeferredToolCatalog,
        activated: Option<Arc<Mutex<BTreeSet<String>>>>,
    ) -> Self {
        Self { catalog, activated }
    }
}

#[async_trait]
impl BuiltinTool for CatalogToolSearchTool {
    fn name(&self) -> &str {
        "toolSearch"
    }

    fn description(&self) -> &str {
        "Search currently permitted tools by keyword or name to inspect their input schemas."
    }

    fn input_schema(&self) -> Value {
        DeferredToolCatalog::tool_search_schema()
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::ParallelRead
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        _ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let found = self.catalog.execute_tool_search(&raw_args)?;
        if let Some(ref act) = self.activated {
            let mut g = act.lock();
            for n in &found.discovered_names {
                if !is_reserved_code_mode_tool(n) {
                    g.insert(n.clone());
                }
            }
        }
        Ok(ToolOutput::Json(found.value))
    }
}

struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct HarnessCodeModeCatalogBridge {
    catalog: DeferredToolCatalog,
    ctx: ToolExecutionContext,
    activated: Option<Arc<Mutex<BTreeSet<String>>>>,
}

impl HarnessCodeModeCatalogBridge {
    fn derived_context_with_cancel(
        &self,
        cancel: &CancellationToken,
    ) -> (ToolExecutionContext, AbortOnDrop) {
        let initially_cancelled = cancel.is_cancelled() || self.ctx.is_cancelled();
        let (tx, rx) = tokio::sync::watch::channel(initially_cancelled);
        let tok = cancel.clone();
        let parent_rx = self.ctx.cancel_rx.clone();

        let watcher = tokio::spawn(async move {
            if initially_cancelled {
                let _ = tx.send(true);
                return;
            }
            match parent_rx {
                Some(mut prx) => {
                    if *prx.borrow() {
                        let _ = tx.send(true);
                        return;
                    }
                    tokio::select! {
                        _ = tok.cancelled() => {
                            let _ = tx.send(true);
                        }
                        _ = async {
                            while prx.changed().await.is_ok() {
                                if *prx.borrow() {
                                    break;
                                }
                            }
                        } => {
                            let _ = tx.send(true);
                        }
                    }
                }
                None => {
                    tok.cancelled().await;
                    let _ = tx.send(true);
                }
            }
        });

        let mut child_ctx = self.ctx.clone();
        child_ctx.cancel_rx = Some(rx);
        (child_ctx, AbortOnDrop(watcher))
    }
}

#[async_trait]
impl CodeModeCatalog for HarnessCodeModeCatalogBridge {
    async fn search(&self, query: &str, cancel: CancellationToken) -> Result<Value, String> {
        if cancel.is_cancelled() || self.ctx.is_cancelled() {
            return Err("code mode cancelled".to_owned());
        }
        self.ctx
            .check_before_tool_invocation("toolSearch")
            .map_err(|e| e.to_string())?;
        let mut args = Map::new();
        args.insert("query".to_owned(), Value::String(query.to_owned()));
        let found = self
            .catalog
            .execute_tool_search(&args)
            .map_err(|e| e.to_string())?;
        if let Some(ref act) = self.activated {
            let mut g = act.lock();
            for n in &found.discovered_names {
                if !is_reserved_code_mode_tool(n) {
                    g.insert(n.clone());
                }
            }
        }
        Ok(found.value)
    }

    async fn call(
        &self,
        name: &str,
        arguments: Value,
        cancel: CancellationToken,
    ) -> Result<Value, String> {
        if cancel.is_cancelled() || self.ctx.is_cancelled() {
            return Err("code mode cancelled".to_owned());
        }
        if is_reserved_code_mode_tool(name) {
            return Err(format!("tool '{name}' cannot be invoked from codeMode"));
        }
        let tool = self
            .catalog
            .inner_tools()
            .get(name)
            .cloned()
            .ok_or_else(|| {
                format!("Tool '{name}' does not exist or is not permitted in this session.")
            })?;
        self.ctx
            .check_before_tool_invocation(name)
            .map_err(|e| e.to_string())?;

        let args_map = match arguments {
            Value::Null => Map::new(),
            Value::Object(m) => m,
            other => {
                return Err(format!(
                    "Tool '{name}' arguments must be a JSON object, received {}",
                    value_kind_label(&other)
                ));
            }
        };

        if let Some(ref act) = self.activated {
            act.lock().insert(name.to_owned());
        }

        let (child_ctx, _cancel_guard) = self.derived_context_with_cancel(&cancel);
        let cancel_grace = async {
            cancel.cancelled().await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        };

        let out = tokio::select! {
            res = tool.execute(args_map, &child_ctx) => {
                res.map_err(|e| e.to_string())?
            }
            _ = cancel_grace => {
                return Err("code mode cancelled".to_owned());
            }
        };
        Ok(out.to_json_value())
    }
}

fn value_kind_label(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Sandboxed `codeMode` built-in tool powered by `cowork-js-vm` (`oxc` + `rquickjs`).
pub struct CodeModeTool {
    catalog: DeferredToolCatalog,
    limits: CodeModeLimits,
    activated: Option<Arc<Mutex<BTreeSet<String>>>>,
}

impl CodeModeTool {
    pub fn new(
        catalog: DeferredToolCatalog,
        activated: Option<Arc<Mutex<BTreeSet<String>>>>,
    ) -> Self {
        Self {
            catalog,
            limits: CodeModeLimits::default(),
            activated,
        }
    }

    pub fn with_limits(mut self, limits: CodeModeLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn code_mode_input_schema(max_source_bytes: usize) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "code": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": max_source_bytes,
                    "description": "Async JavaScript or TypeScript function body. Use await tools.search(query) and await tools.call(name, arguments); return JSON data."
                }
            },
            "required": ["code"]
        })
    }

    pub async fn execute_with_details(
        &self,
        code: &str,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<CodeModeExecutionResult> {
        if ctx.is_cancelled() {
            return Err(ToolError::Execution("code mode cancelled".to_owned()));
        }

        let cancel_token = CancellationToken::new();
        let watcher = ctx.cancel_rx.clone().map(|mut rx| {
            let tok = cancel_token.clone();
            tokio::spawn(async move {
                if *rx.borrow() {
                    tok.cancel();
                    return;
                }
                while rx.changed().await.is_ok() {
                    if *rx.borrow() {
                        tok.cancel();
                        break;
                    }
                }
            })
        });

        let bridge = Arc::new(HarnessCodeModeCatalogBridge {
            catalog: self.catalog.clone(),
            ctx: ctx.clone(),
            activated: self.activated.clone(),
        });

        let res = execute_code_mode(
            code,
            bridge,
            CodeModeOptions {
                limits: self.limits.clone(),
                cancel_token: Some(cancel_token),
                on_call_event: None,
            },
        )
        .await;

        if let Some(handle) = watcher {
            handle.abort();
        }

        res.map_err(|e| ToolError::Execution(e.to_string()))
    }
}

#[async_trait]
impl BuiltinTool for CodeModeTool {
    fn name(&self) -> &str {
        "codeMode"
    }

    fn description(&self) -> &str {
        CODE_MODE_DESCRIPTION
    }

    fn input_schema(&self) -> Value {
        Self::code_mode_input_schema(self.limits.max_source_bytes)
    }

    fn execution_policy(&self) -> ToolExecutionPolicy {
        ToolExecutionPolicy::Sequential
    }

    async fn execute(
        &self,
        raw_args: Map<String, Value>,
        ctx: &ToolExecutionContext,
    ) -> ToolResult<ToolOutput> {
        let schema = self.input_schema();
        let args = normalize_and_validate_args(&schema, &raw_args)?;
        let code = args
            .get("code")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("code is required".to_owned()))?;
        let outcome = self.execute_with_details(code, ctx).await?;
        Ok(ToolOutput::Json(outcome.value))
    }
}
