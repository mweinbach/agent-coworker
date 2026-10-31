# Tool Calling: Native Rust Transports, Codex, and Optional Envelopes

## Runtime Ownership

`crates/cowork-inference/` and `crates/cowork-providers/` own provider wire streaming directly in Rust (`reqwest` + `rustls` + `eventsource-stream` / `aws-smithy-eventstream` / stdio JSON-RPC) with zero external JavaScript LLM SDKs. `crates/cowork-harness/` (`TurnStepRunner`) owns the multi-step turn loop, tool validation, execution, cancellation, and retry policy.

Prompt cache retention is optional and provider-specific:

```json
{
  "providerOptions": {
    "anthropic": { "cacheRetention": "long" }
  }
}
```

Accepted values are `none`, `short`, and `long`. Omission preserves the provider transport's default; support and pricing remain provider-dependent.

### Request Budgets and Execution Policy

Each model step enforces a `300,000 ms` overall step budget across attempts, stream consumption, and pre-output backoff, with a `120,000 ms` per-HTTP-attempt timeout (`crates/cowork-inference/src/reliability.rs`). Transient `429`, `408`, `5xx`, and transport errors are retried with exponential backoff + jitter (honoring `Retry-After`) strictly **before** any visible assistant output delta or tool call has streamed; once visible output begins, mid-stream failures surface truthfully without duplicate replay.

The selected provider's `providerOptions` section can override `timeoutMs` (`1–600,000`), `stepTimeoutMs` (`1–1,800,000`), and `maxRetryDelayMs` (`0–60,000`). Cancellation and deadlines suppress late provider output and tear down active streams immediately.

Direct tool execution in `crates/cowork-tools/src/catalog.rs` stays sequential (`ToolExecutionPolicy::Sequential`) unless a tool explicitly declares `ToolExecutionPolicy::ParallelRead` (currently `glob`). Consecutive `ParallelRead` calls execute in batches of at most `4` (`MAX_PARALLEL_READ_BATCH`) and commit results in deterministic call order; other calls act as ordering barriers.

Codex app-server (`crates/cowork-providers/src/codex_app_server/`) owns its own agent loop and native local execution tools under an isolated `~/.cowork/auth/codex-cli` home. Cowork supplies sandbox policy and bridges approval and `dynamicTools` requests. Native delegation is disabled so child agents run through Cowork's `AgentControl` lifecycle, scope, and budget controls. Because the pinned Codex wire protocol does not support `networkAccess: false` on `dangerFullAccess`, Cowork narrows network-disabled full-access/YOLO turns to `workspaceWrite` with explicit filtered scratch roots.

## Optional Tool Primitives

Both settings default to `false` and can be enabled in `~/.cowork/config/config.json` or `.cowork/config.json`:

```json
{
  "toolCalling": {
    "codeMode": true,
    "deferredToolSearch": true
  }
}
```

- **`deferredToolSearch`** (`crates/cowork-tools/src/catalog.rs`) replaces eager built-in tool schemas with compact `toolSearch({ query, limit?, offset? })` and `toolCall({ name, arguments })` envelopes across all non-Codex providers. Search returns complete JSON Schemas, defaults to 5 matches, and supports pagination and `*` browsing.
- **`codeMode`** (`crates/cowork-js-vm/` + `crates/cowork-tools/src/code_mode_tool.rs`) exposes `codeMode({ code })`, stripping TypeScript syntax via `oxc` (`SemanticBuilder` + `Transformer`) and executing the script inside an isolated cross-platform `rquickjs` context across macOS, Linux, and Windows. Inside `codeMode`, scripts call `await tools.search(query)` and `await tools.call(name, arguments)` and return structured JSON.

Example `codeMode` body:

```ts
const patterns: string[] = ["src/**/*.ts", "test/**/*.test.ts"];
const files = await Promise.all(
  patterns.map((pattern) => tools.call("glob", { pattern, maxResults: 20 })),
);
return patterns.map((pattern, index) => ({ pattern, files: files[index] }));
```

Keep dependent writes ordered with separate `await` expressions; completed side effects are not rolled back if a later call fails.

### Authority and VM Isolation

The deferred/code-mode catalog is assembled **after** provider ownership, agent-role, task-context, and profile filtering. It cannot recover tools withheld from a Codex turn, grant root-only thread tools to a child/task session, or activate an untrusted workspace MCP server before `trustWorkspaceMcp` approval.

`crates/cowork-js-vm/` enforces:

- **Zero external imports**: `import` / `export` / dynamic `import()` statements are rejected at compile time and by a rejecting module loader.
- **Hard per-isolate heap cap**: `rquickjs::Runtime::set_memory_limit` (`64 MiB` default) deterministically halts runaway allocations on macOS, Linux, and Windows without crashing `cowork-server`.
- **Wall-clock interrupt & call budgets**: `30s` wall-clock interrupt handler (halting `while (true) {}` loops), frozen JS intrinsics, bounded concurrency (`4`), call/search count caps (`64`), and transport/output byte caps.
- **Cascading cancellation**: `turn/interrupt` or `codeMode` timeout cancels nested in-flight tool calls via a derived cancellation channel.

`toolCall` preserves underlying tool results and citation metadata. `read` and `skill` results remain exempt from `.cowork/.cowork-scratchpad` overflow spilling (`crates/cowork-tools/src/overflow.rs`) so full skill instructions and requested file slices stay inline.

## Verification

- Rust VM & tool-calling suites:
  - `cargo test -p cowork-js-vm`
  - `cargo test -p cowork-tools`
  - `cargo test -p cowork-harness`
- Black-box server integration suites:
  - `bun run test -- test/rust-server.jsonrpc-turns-and-tools.integration.test.ts`
