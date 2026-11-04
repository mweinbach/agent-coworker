# Building Custom Tools

The `agent-coworker` toolbelt lives in the Rust `crates/cowork-tools/` crate. Developers can add new built-in tools by implementing the `BuiltinTool` trait and registering them in `create_builtin_tools()`. This guide explains how tools are structured, registered, and wired to approvals, cancellation, and path confinement.

## Tool Structure and Registration

Custom tools are implemented in `crates/cowork-tools/src/` (for example, `my_custom_tool.rs`) by implementing `BuiltinTool` from `crates/cowork-tools/src/context.rs`.

Once implemented, register the tool in `create_builtin_tools()` inside `crates/cowork-tools/src/catalog.rs` (and re-export it from `crates/cowork-tools/src/lib.rs` if needed by tests or downstream crates):

```rust
// crates/cowork-tools/src/catalog.rs
pub fn create_builtin_tools(ctx: &ToolExecutionContext) -> ToolMap {
    let mut tools: ToolMap = BTreeMap::new();
    // Built-in tools...
    tools.insert("bash".to_owned(), Arc::new(BashTool));
    tools.insert("read".to_owned(), Arc::new(ReadTool));
    // Register your custom tool:
    tools.insert("myCustomTool".to_owned(), Arc::new(MyCustomTool));
    tools
}
```

## Tool Definitions and JSON Schema

Each `BuiltinTool` defines:

- `name(&self) -> &str` — canonical callable tool ID exposed to providers and prompts
- `description(&self) -> &str` — concise model-facing guidance
- `input_schema(&self) -> serde_json::Value` — JSON Schema object describing accepted arguments
- `execution_policy(&self) -> ToolExecutionPolicy` — `ToolExecutionPolicy::Sequential` (default) or `ToolExecutionPolicy::ParallelRead` (for pure, side-effect-free read tools)
- `async fn execute(&self, args: Value, ctx: &ToolExecutionContext) -> ToolResult<ToolOutput>` — validated execution logic

Use `normalize_and_validate_args(&args, &self.input_schema())` from `crates/cowork-tools/src/context.rs` to normalize provider-emitted `null` optionals and validate arguments against your JSON Schema before running side effects.

## The `ToolExecutionContext` Object

Every tool invocation receives `&ToolExecutionContext` (`crates/cowork-tools/src/context.rs`), which provides workspace confinement, interactive approvals, and cancellation controls:

### Path Confinement: `assert_read_path_allowed` & `assert_write_path_allowed`

Always resolve user/model-supplied paths against `ctx.working_directory` and validate them with `assert_read_path_allowed(path, ctx)` or `assert_write_path_allowed(path, ctx)` so read-only roles, `no-project-write` policies, and child-agent `target_paths` remain enforced. File edits and writes should coordinate through `with_file_mutation` (`crates/cowork-tools/src/mutation.rs`).

### Security and Approvals: `ctx.approval_handler`

For tools that perform potentially destructive or sensitive actions, request explicit user approval over the JSON-RPC server-request channel (`item/commandExecution/requestApproval`) via `ctx.approval_handler`:

- When `ctx.yolo` is `true` (and no hard sandbox floor applies), command/file approvals auto-approve.
- Otherwise, tool execution suspends until the client resolves the request; if denied, return `Err(ToolError::Execution(...))` without performing the side effect.

### Handling Cancellation: `ctx.is_cancelled()`

Turns can be interrupted mid-flight via `turn/interrupt`. Check `ctx.is_cancelled()` (or select on `ctx.cancel_rx.clone()`) across async waits and multi-step loops so cancelled turns stop promptly and reap any spawned child processes.

## Code Example: A Custom Rust Tool

```rust
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::time::{Duration, sleep};

use crate::context::{
    ApprovalDecisionRequest, BuiltinTool, ToolError, ToolExecutionContext, ToolOutput, ToolResult,
    normalize_and_validate_args,
};

pub struct MyCustomTool;

#[async_trait]
impl BuiltinTool for MyCustomTool {
    fn name(&self) -> &str {
        "myCustomTool"
    }

    fn description(&self) -> &str {
        "Run a bounded, user-approved operation against a named target."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetName": {
                    "type": "string",
                    "description": "The name of the target to operate on."
                },
                "iterations": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "default": 3
                }
            },
            "required": ["targetName"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolExecutionContext) -> ToolResult<ToolOutput> {
        let normalized = normalize_and_validate_args(&args, &self.input_schema())?;
        let target_name = normalized
            .get("targetName")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidArguments("targetName is required".to_owned()))?;
        let iterations = normalized
            .get("iterations")
            .and_then(Value::as_u64)
            .unwrap_or(3);

        if !ctx.yolo {
            if let Some(handler) = &ctx.approval_handler {
                let approved = handler
                    .approve_command(ApprovalDecisionRequest {
                        command: format!("myCustomTool {target_name}"),
                        reason: "Sensitive custom operation".to_owned(),
                        dangerous: false,
                        detail: None,
                        category: None,
                    })
                    .await
                    .map_err(ToolError::Execution)?;
                if !approved {
                    return Err(ToolError::Execution("Operation denied by user.".to_owned()));
                }
            }
        }

        for step in 1..=iterations {
            if ctx.is_cancelled() {
                return Err(ToolError::Execution(format!(
                    "Operation cancelled at step {step}."
                )));
            }
            sleep(Duration::from_millis(50)).await;
        }

        Ok(ToolOutput::Text(format!(
            "Successfully completed {iterations} steps on {target_name}."
        )))
    }
}
```
