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

## Tool Search and Programmatic Tool Calling (`toolCalling`)

`codeMode` and `deferredToolSearch` default to `false` with `strategy: "auto"`, and can be configured in `~/.cowork/config/config.json`, `.cowork/config.json`, session overrides (`cowork/session/config/set` / `cowork/session/defaults/apply`), or environment variables (`COWORK_CODE_MODE`, `COWORK_DEFERRED_TOOL_SEARCH`, `COWORK_TOOL_CALLING_STRATEGY`):

```json
{
  "toolCalling": {
    "codeMode": true,
    "deferredToolSearch": true,
    "strategy": "auto"
  }
}
```

### Strategy Modes (`"auto" | "native" | "harness"`)

- **`"auto"`** *(default)*: Uses provider-native wire primitives when the resolved `(provider, model, base_url)` supports them, and transparently falls back to Cowork's local harness implementation when unsupported or rejected.
- **`"native"`**: Prefers provider-native wire envelopes even on custom/proxy base URLs unless the endpoint explicitly rejects the payload at runtime.
- **`"harness"`**: Forces Cowork's provider-agnostic harness envelopes (`toolSearch` + `toolCall` and QuickJS `codeMode`) even on providers that offer native server tools.

### 3-Layer Endpoint Capability Resolution & Fallback (`crates/cowork-providers/src/endpoint_capabilities.rs`)

1. **Static Host + Model Classifier**: Recognizes official endpoints and model families (`api.openai.com` with `gpt-5.4+`, `openrouter.ai`, `api.anthropic.com` with Claude Sonnet/Opus 4+, and `codex-cli`). Loopback and unrecognized OpenAI-compatible hosts default to `"harness"` under `strategy: "auto"` unless probed or forced via `strategy: "native"`.
2. **Active Endpoint Probe (`cowork/provider/capabilities/check` & Preflight)**: Probes `GET {base_url}/v1/models/{model_id}` (Anthropic, inspecting `capabilities.code_execution.supported` and `tool_search`) or `GET {base_url}/models/{model_id}` (OpenAI/OpenRouter/compatible endpoints, inspecting `capabilities`, `owned_by`, response headers, and status), caching results in-process for 15 minutes. When a client supplies an unconfigured `baseUrl` override to `cowork/provider/capabilities/check`, saved API keys are withheld to prevent credential exfiltration.
3. **Pre-Output Runtime Fallback**: If an endpoint returns HTTP `400`, `404`, or `422` rejecting native tool-search or code-execution fields before any visible assistant delta or tool call is emitted, the transport records the rejection in the capability cache and immediately retries the request with standard eager function tools.

### Native Provider Wire Formats

- **OpenAI Responses & OpenRouter (`crates/cowork-providers/src/openai_responses.rs`)**:
  - Native tool search emits `{"type": "tool_search"}` (or `{"type": "openrouter:tool_search"}` on OpenRouter) alongside `"defer_loading": true` on deferred function schemas, replaying `tool_search_call` and `tool_search_output` items across multi-step turns.
  - Native programmatic tool calling emits `{"type": "programmatic_tool_calling"}` and marks eligible function tools with `"allowed_callers": ["direct", "programmatic"]`, echoing `caller` on `function_call_output` items and continuing empty-input `program_output` steps automatically.
- **Anthropic Messages (`crates/cowork-providers/src/anthropic_messages.rs`)**:
  - Native tool search emits `tool_search_tool_bm25_20251119` (or `tool_search_tool_regex_20251119`) with `"defer_loading": true` on deferred tools while keeping core tools non-deferred first and placing prompt-cache `cache_control` on the last non-deferred tool.
  - Native programmatic tool calling emits `code_execution_20260120` and `"allowed_callers": ["direct", "code_execution_20260120"]` on eligible tools (interactive `askUserQuestion` and `$ref` schemas stay direct-only), preserves `server_tool_use`, `tool_search_tool_result`, `code_execution_tool_result`, and `tool_use.caller` metadata, reuses active `container` IDs across steps, and automatically continues `stop_reason: "pause_turn"` steps.
- **Codex App-Server (`crates/cowork-providers/src/codex_app_server/mod.rs`)**:
  - Forwards explicit `features.code_mode` when `codeMode` resolves to native execution on `codex-cli`.
- **Per-Turn Tool Suppression (`turn/start` `tools: "none"`)**:
  - When a turn sets `tools: "none"`, all built-in tools, MCP tools, harness meta-tools, native server tools, and `container` continuations are suppressed for that turn.

### Local Harness Primitives

- **`deferredToolSearch`** (`crates/cowork-tools/src/catalog.rs`) replaces eager built-in tool schemas with compact `toolSearch({ query, limit?, offset? })` and `toolCall({ name, arguments })` envelopes across non-Codex providers when using the harness path. Search returns complete JSON Schemas, defaults to 5 matches, and supports pagination and `*` browsing.
- **`codeMode`** (`crates/cowork-js-vm/` + `crates/cowork-tools/src/code_mode_tool.rs`) exposes `codeMode({ code })` on the harness path, stripping TypeScript syntax via `oxc` (`SemanticBuilder` + `Transformer`) and executing the script inside an isolated cross-platform `rquickjs` context across macOS, Linux, and Windows. Inside `codeMode`, scripts call `await tools.search(query)` and `await tools.call(name, arguments)` and return structured JSON.

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

The tool catalog (both native and harness) is assembled **after** provider ownership, agent-role, task-context, and profile filtering. Neither native server tools nor harness `codeMode`/`toolSearch` can recover tools withheld from a Codex turn, grant root-only thread tools to a child/task session, or activate an untrusted workspace MCP server before `trustWorkspaceMcp` approval.

`crates/cowork-js-vm/` enforces:

- **Zero external imports**: `import` / `export` / dynamic `import()` statements are rejected at compile time and by a rejecting module loader.
- **Hard per-isolate heap cap**: `rquickjs::Runtime::set_memory_limit` (`64 MiB` default) deterministically halts runaway allocations on macOS, Linux, and Windows without crashing `cowork-server`.
- **Wall-clock interrupt & call budgets**: `30s` wall-clock interrupt handler (halting `while (true) {}` loops), frozen JS intrinsics, bounded concurrency (`4`), call/search count caps (`64`), and transport/output byte caps.
- **Cascading cancellation**: `turn/interrupt` or `codeMode` timeout cancels nested in-flight tool calls via a derived cancellation channel.

`toolCall` preserves underlying tool results and citation metadata. `read` and `skill` results remain exempt from `.cowork/.cowork-scratchpad` overflow spilling (`crates/cowork-tools/src/overflow.rs`) so full skill instructions and requested file slices stay inline.

## Verification

- Rust VM, provider, & tool-calling suites:
  - `cargo test -p cowork-js-vm`
  - `cargo test -p cowork-providers`
  - `cargo test -p cowork-tools`
  - `cargo test -p cowork-harness`
- Black-box server integration suites:
  - `bun run test -- test/rust-server.jsonrpc-turns-and-tools.integration.test.ts`
