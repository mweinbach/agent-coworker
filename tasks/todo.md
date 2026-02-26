# Task: Migrate from Vercel AI SDK to Pi Framework (`@mariozechner/pi-ai` + `@mariozechner/pi-agent-core`)

## Summary

Replace the Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/mcp`) with the Pi framework (`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`) while preserving all four provider backends (Anthropic, OpenAI, Google, Codex CLI) as first-class citizens.

## Key Architecture Decisions

### D1 — Tool Schema Format: Zod → TypeBox
Pi uses TypeBox (`@sinclair/typebox`) for tool parameter schemas instead of Zod. Since TypeBox compiles to standard JSON Schema and pi validates with AJV internally, we have two options:
- **Option A (Recommended)**: Convert tool schemas to TypeBox. This is cleaner and avoids runtime conversion overhead. TypeBox is re-exported from `@mariozechner/pi-ai` so no extra dependency needed.
- **Option B**: Write a `zodToJsonSchema()` adapter that converts at tool registration time. Keeps existing Zod schemas but adds indirection.

**Decision: Option A** — Convert to TypeBox. The tool count is manageable (14 built-in) and TypeBox schemas are more concise.

### D2 — Agent Loop Strategy: `agentLoop()` vs manual `stream()` + tool dispatch
- **`agentLoop()`** (from `pi-agent-core`): Handles the full multi-turn cycle (LLM call → tool execution → next LLM call). Yields fine-grained events. This is pi's idiomatic approach.
- **`stream()`** (from `pi-ai`): Low-level single-turn streaming. Requires manual tool dispatch loop.

**Decision: `agentLoop()`** — It handles tool execution, validation, and multi-turn orchestration out of the box. Our `runTurn()` currently delegates all of this to AI SDK's `streamText()` with `stopWhen: stepCountIs(N)`, so `agentLoop()` is the natural replacement. We'll consume its events to drive `onModelStreamPart`.

### D3 — Message Type: `ModelMessage` → Pi's `Message`
Pi defines `UserMessage`, `AssistantMessage`, and `ToolResultMessage` with timestamps and richer metadata. We need to:
1. Define a type alias `type AgentMessage = import("@mariozechner/pi-ai").Message` (or similar)
2. Update all message-touching code (HistoryManager, SessionContext, sessionStore, sessionDb)
3. Adapt serialization/deserialization in session persistence

### D4 — MCP Integration
Pi does not bundle `@ai-sdk/mcp`. Options:
- **Option A (Recommended)**: Keep `@modelcontextprotocol/sdk` (already a dependency) and build a thin adapter that converts MCP tool definitions to Pi `AgentTool` format.
- **Option B**: Use pi's extension system to register MCP tools.

**Decision: Option A** — Direct adapter. The existing MCP loading code is solid; we just need to change the output format from AI SDK `tool()` to Pi `AgentTool`.

### D5 — Provider-Native Tools (webSearch)
Currently `webSearch` uses `anthropic.tools.webSearch_20250305()` and `openai.tools.webSearch({})` for provider-native web search. Pi doesn't re-export these provider-native tool constructors.
- **Decision**: For Anthropic and OpenAI, we'll need to either:
  - Keep `@anthropic-ai/sdk` and `openai` SDK direct dependencies (which pi already depends on internally) for native tool access
  - Or convert all providers to the custom Brave/Exa search implementation

  **We'll keep provider-native tools** by importing from the underlying SDKs that pi already depends on, and wrap them as Pi `AgentTool` format.

### D6 — `generateObject()` Replacement
Pi doesn't have a direct `generateObject()` equivalent (used for session title generation). Options:
- Use `complete()` with a JSON-formatted prompt and parse the response
- Use pi's `stream()` with a schema instruction and validate with TypeBox/AJV
- Keep a minimal shim using the underlying provider SDKs directly

**Decision**: Use `complete()` + JSON prompt + TypeBox validation. This is what `generateObject` does under the hood anyway.

### D7 — Observability / Telemetry
The current `TelemetrySettings` type comes from AI SDK. Pi doesn't have built-in Langfuse integration.
- **Decision**: Keep the existing OpenTelemetry/Langfuse setup but decouple it from AI SDK's `TelemetrySettings` type. Instrument pi's event stream manually with spans.

### D8 — Google Thought Signature Replay
`buildGooglePrepareStep()` repairs Gemini thought signatures across tool calls. Pi handles thinking/reasoning via `streamSimple()` with a unified `reasoning` parameter.
- **Decision**: Investigate if pi's Google provider handles thought signatures internally. If not, port the repair logic to work with pi's message format.

---

## Phase 0: Preparation & Scaffolding
- [ ] Create `src/pi/` adapter directory for migration helpers
- [ ] Add pi dependencies: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`
- [ ] Keep AI SDK dependencies temporarily for incremental migration
- [ ] Create `src/pi/types.ts` — Canonical message type aliases mapping pi's `Message` types to our domain
- [ ] Create `src/pi/toolAdapter.ts` — Utility to convert our tool definitions to Pi `AgentTool` format
- [ ] Verify pi packages install and basic `getModel()` + `stream()` works with each provider (Anthropic, OpenAI, Google)
- [ ] Run `bun test` to confirm nothing breaks from just adding dependencies

## Phase 1: Provider System Migration (`src/providers/`)
- [ ] **`src/providers/anthropic.ts`**: Replace `@ai-sdk/anthropic` imports with `getModel("anthropic", ...)` from `@mariozechner/pi-ai`. Map `DEFAULT_ANTHROPIC_PROVIDER_OPTIONS` (thinking budget, disableParallelToolUse) to pi's provider options format (e.g., `streamSimple` reasoning config).
- [ ] **`src/providers/openai.ts`**: Replace `@ai-sdk/openai` imports with `getModel("openai", ...)`. Map `DEFAULT_OPENAI_PROVIDER_OPTIONS` (reasoningEffort, textVerbosity) to pi equivalents.
- [ ] **`src/providers/google.ts`**: Replace `@ai-sdk/google` imports with `getModel("google", ...)`. Map `DEFAULT_GOOGLE_PROVIDER_OPTIONS` (thinkingConfig) to pi's thinking options.
- [ ] **`src/providers/codex-cli.ts`**: This uses OpenAI SDK with custom baseURL + OAuth fetch. Pi supports custom OpenAI-compatible endpoints. Adapt `createOpenAI({ baseURL, fetch })` pattern to pi's custom model registration (via `customModels` config or direct model object construction).
- [ ] **`src/providers/index.ts`**: Update `ProviderRuntimeDefinition.createModel()` return type from AI SDK `LanguageModel` to pi's `Model` type. Update `getModelForProvider()`.
- [ ] **`src/providers/providerOptions.ts`**: Remap `DEFAULT_PROVIDER_OPTIONS` from AI SDK provider option shapes to pi's option shapes (per-provider reasoning/thinking configs).
- [ ] **`src/config.ts`**: Update `getModel()` to return pi `Model` instead of AI SDK model instance.
- [ ] **`src/providers/googleReplay.ts`**: Evaluate if pi's Google provider handles thought signatures. If not, port `buildGooglePrepareStep()` to work with pi's `Message` types instead of `ModelMessage`.
- [ ] Run provider-specific tests: `bun test test/providers/`

## Phase 2: Tool System Migration (`src/tools/`)
- [ ] **`src/tools/context.ts`**: No changes needed (doesn't depend on AI SDK).
- [ ] **Convert tool schemas from Zod to TypeBox** for all 14 tools. Create each tool as a Pi `AgentTool` with `name`, `label`, `description`, `parameters` (TypeBox), and `execute`:
  - [ ] `src/tools/bash.ts` — `tool()` → `AgentTool` with TypeBox `Type.Object({ command: Type.String(), ... })`
  - [ ] `src/tools/read.ts`
  - [ ] `src/tools/write.ts`
  - [ ] `src/tools/edit.ts`
  - [ ] `src/tools/glob.ts`
  - [ ] `src/tools/grep.ts`
  - [ ] `src/tools/ask.ts`
  - [ ] `src/tools/todoWrite.ts`
  - [ ] `src/tools/webFetch.ts`
  - [ ] `src/tools/webSearch.ts` — Also migrate provider-native tool wrappers (Anthropic webSearch, OpenAI webSearch) to Pi-compatible format or custom implementations
  - [ ] `src/tools/spawnAgent.ts` — Internal `streamText()` call must also be migrated to pi's `agentLoop()` or `stream()`
  - [ ] `src/tools/notebookEdit.ts`
  - [ ] `src/tools/skill.ts`
  - [ ] `src/tools/memory.ts`
- [ ] **`src/tools/index.ts`**: Update `createTools()` return type from `Record<string, any>` (AI SDK tool objects) to `AgentTool[]` (pi expects an array).
- [ ] Run tool tests: `bun test test/tools.test.ts`

## Phase 3: Core Agent Loop Migration (`src/agent.ts`)
- [ ] Replace `streamText` import with pi's `agentLoop` (or `stream` if manual control needed)
- [ ] Replace `stepCountIs` with pi's built-in loop termination or manual step counting in the event consumer
- [ ] Replace `ModelMessage` type with pi's `Message` type throughout
- [ ] Rewrite `runTurn()` to:
  1. Build pi `Context` object (`{ systemPrompt, messages, tools }`)
  2. Build pi `AgentLoopConfig` (`{ model, convertToLlm, transformContext }`)
  3. Call `agentLoop([userMessage], context, config)` and iterate events
  4. Map pi events (`message_update`, `tool_execution_start/update/end`, `turn_end`, `agent_end`) to our existing `onModelStreamPart` callback format
  5. Extract final text, reasoning, response messages, and usage from events
- [ ] Update `RunTurnDeps` type to reflect pi dependencies instead of AI SDK
- [ ] Update `RunTurnParams` — remove `includeRawChunks` (pi doesn't have this concept), adapt telemetry context
- [ ] Handle abort signal integration — pi's `agentLoop` accepts `AbortSignal` via config
- [ ] Port MCP tool merging to work with pi's `AgentTool[]` format instead of `Record<string, tool>`
- [ ] Run agent tests: `bun test test/agent/`

## Phase 4: Message Type Migration (Session Layer)
- [ ] **`src/types.ts`**: Replace `import type { ModelMessage } from "ai"` with pi's `Message` type. Define any needed type aliases.
- [ ] **`src/server/session/SessionContext.ts`**: Update all `ModelMessage` references to pi `Message`
- [ ] **`src/server/session/HistoryManager.ts`**: Update `appendMessagesToHistory()` signature and windowing logic
- [ ] **`src/server/sessionStore.ts`**: Update session snapshot serialization. Pi messages have `timestamp` fields and different content structures — ensure backward compatibility with existing persisted sessions (migration strategy needed).
- [ ] **`src/server/sessionDb/mappers.ts`**: Update message mapping for database persistence
- [ ] **`src/server/sessionDb/repository.ts`**: Update repository types
- [ ] **`src/server/sessionDb.ts`**: Update DB session types
- [ ] **`src/server/session/TurnExecutionManager.ts`** (if it references `ModelMessage`): Update
- [ ] Add session snapshot migration logic: detect AI SDK `ModelMessage` format on load, convert to pi `Message` format transparently
- [ ] Run session tests: `bun test test/session*`

## Phase 5: Session Title Service
- [ ] **`src/server/sessionTitleService.ts`**: Replace `generateObject()` with pi's `complete()` + JSON prompt + response parsing. Use TypeBox schema for validation instead of Zod.
- [ ] Update `SessionTitleDeps` type
- [ ] Run title service tests

## Phase 6: MCP Integration
- [ ] **`src/mcp/index.ts`**: Replace `@ai-sdk/mcp` imports (`createMCPClient`, `OAuthClientProvider`, `Experimental_StdioMCPTransport`) with direct `@modelcontextprotocol/sdk` usage
- [ ] Create MCP tool adapter: convert MCP `Tool` definitions to Pi `AgentTool` format
- [ ] Update `loadMCPTools()` to return `AgentTool[]` instead of AI SDK tool records
- [ ] Verify OAuth provider flow still works without `@ai-sdk/mcp`'s `OAuthClientProvider` type
- [ ] Run MCP tests: `bun test test/mcp*`

## Phase 7: Observability
- [ ] **`src/observability/runtime.ts`**: Remove `TelemetrySettings` import from `"ai"`. Define our own telemetry interface.
- [ ] Create pi event → OpenTelemetry span mapping (instrument `agentLoop` events with manual spans)
- [ ] Verify Langfuse integration still works end-to-end
- [ ] Run observability tests

## Phase 8: Sub-Agent (spawnAgent) Migration
- [ ] **`src/tools/spawnAgent.ts`**: Replace internal `streamText()` + `stepCountIs()` with pi's `agentLoop()` for sub-agent runs
- [ ] Ensure sub-agent tool subsets are passed correctly as `AgentTool[]`
- [ ] Verify depth limiting still works
- [ ] Run spawn agent tests

## Phase 9: Test Harness & Scripts
- [ ] **`scripts/run_raw_agent_loops.ts`**: Migrate from `generateText`/`stepCountIs`/`tool` to pi equivalents
- [ ] **`test/tools.test.ts`**: Update schema validation from `asSchema` (`@ai-sdk/provider-utils`) to TypeBox schema introspection
- [ ] **`test/providers/*.test.ts`**: Update provider tests to use pi model creation
- [ ] **`test/providers/live-api.integration.test.ts`**: Update integration tests
- [ ] **`test_model.ts`**: Update if it exists as a test utility

## Phase 10: Cleanup & Dependency Removal
- [ ] Remove AI SDK dependencies from `package.json`:
  - `"ai"`
  - `"@ai-sdk/anthropic"`
  - `"@ai-sdk/google"`
  - `"@ai-sdk/openai"`
  - `"@ai-sdk/mcp"`
- [ ] Remove any remaining `from "ai"` or `from "@ai-sdk/*"` imports
- [ ] Replace `zod` with TypeBox where it was only used for tool schemas (keep `zod` for other validation — it's used extensively beyond tools)
- [ ] Run full test suite: `bun test`
- [ ] Run TypeScript check: `npx tsc --noEmit`
- [ ] Manual smoke test: `bun run cli` with each provider

## Phase 11: Documentation & Protocol
- [ ] Update `docs/websocket-protocol.md` if message shapes changed
- [ ] Update `CLAUDE.md` to reflect pi framework instead of AI SDK
- [ ] Update any inline documentation referencing AI SDK patterns

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pi message format incompatible with persisted sessions | High | Add migration layer in sessionStore that converts old ModelMessage on load |
| Provider-native webSearch tools unavailable in pi | Medium | Fall back to custom Brave/Exa implementations for all providers |
| Google thought signature replay not handled by pi | Medium | Port existing repair logic to pi's message format |
| Codex CLI custom OAuth flow breaks | High | Pi supports custom OpenAI-compatible endpoints; test thoroughly |
| MCP OAuth flow depends on `@ai-sdk/mcp` types | Medium | Implement OAuth provider interface directly against `@modelcontextprotocol/sdk` |
| TypeBox learning curve for contributors | Low | TypeBox API is simpler than Zod; document patterns |
| `generateObject()` replacement less robust | Low | JSON prompt + validation is battle-tested |
| Stream event mapping incomplete | Medium | Exhaustive event type mapping with fallback logging |

---

## File Impact Summary

**High-impact files (core logic changes):**
- `src/agent.ts` — Complete rewrite of turn loop
- `src/providers/*.ts` — All 4 providers rewritten
- `src/tools/*.ts` — All 14 tools converted
- `src/mcp/index.ts` — MCP adapter rewritten

**Medium-impact files (type changes):**
- `src/types.ts`
- `src/server/session/SessionContext.ts`
- `src/server/session/HistoryManager.ts`
- `src/server/sessionStore.ts`
- `src/server/sessionDb/*.ts`
- `src/server/sessionTitleService.ts`
- `src/observability/runtime.ts`
- `src/providers/googleReplay.ts`

**Low-impact files (import updates):**
- `scripts/run_raw_agent_loops.ts`
- `test/**/*.ts`
- `package.json`

**No changes needed:**
- TUI layer (only consumes WebSocket events, never touches AI SDK directly)
- CLI REPL
- Server/protocol layer (messages are already serialized as JSON)
- Config loading (except `getModel()` return type)
