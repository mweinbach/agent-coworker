# Task: Remove AI SDK dependencies completely (PI-only runtime)

## Plan
- [x] Remove all `ai` / `@ai-sdk/*` imports from `src/` runtime paths and keep PI as the sole production runtime.
- [x] Replace AI SDK `ModelMessage` and `tool()` usage with local types/helpers.
- [x] Replace `@ai-sdk/mcp` client plumbing with `@modelcontextprotocol/sdk` client transports.
- [x] Refactor provider model adapters to local implementations (no AI SDK provider packages) while preserving existing config/header behavior.
- [x] Update tests that assert AI SDK-specific behavior to the PI/local-adapter behavior.
- [x] Remove `ai` / `@ai-sdk/*` dependencies from `package.json` and refresh lockfile.
- [x] Run targeted suites + full `bun test`, then document review outcomes.

## Review
- Removed all runtime/test/script imports from `ai` and `@ai-sdk/*`; PI runtime is now the only model runtime in `src/runtime/`.
- Replaced SDK-coupled tool wrappers with a local `defineTool()` helper and moved `ModelMessage` to a local type in `src/types.ts`.
- Replaced MCP client integration from `@ai-sdk/mcp` to direct `@modelcontextprotocol/sdk` transports (`stdio`, `sse`, `streamableHttp`) while preserving `loadMCPTools()` behavior.
- Refactored provider adapters to local header-based model adapters (`src/providers/modelAdapter.ts`) and removed AI SDK provider package usage.
- Removed AI SDK fallback title generation path; session titles now use runtime turn calls only.
- Updated docs (`README.md`, `docs/architecture.md`, `docs/custom-tools.md`, `docs/harness/observability.md`, `docs/websocket-protocol.md`) to reflect PI-only runtime/tooling language.
- Verification:
  - `bun test test/runtime.selection.test.ts test/runtime.pi-message-bridge.test.ts test/runtime.pi-options.test.ts test/session-title-service.test.ts test/config.test.ts test/providers/index.test.ts test/providers/openai.test.ts test/providers/google.test.ts test/providers/anthropic.test.ts test/providers/codex-cli.test.ts test/providers/saved-keys.test.ts test/providers/provider-options.test.ts test/tools.test.ts test/mcp.test.ts test/mcp.local.integration.test.ts test/agent.test.ts test/spawnAgent.tool.test.ts` -> **355 pass, 0 fail**
  - `bun test` -> **1684 pass, 2 skip, 0 fail**

---

# Task: Migrate agent runtime from AI SDK to PI (all phases)

## Plan
- [x] Phase 1: Introduce a runtime abstraction (`LLMRuntime`) and route `runTurn` through it while preserving behavior.
- [x] Phase 2: Add a PI-backed runtime implementation behind config/runtime selection and keep AI SDK runtime available during transition.
- [x] Phase 3: Keep first-class provider behavior by mapping provider/model/auth/options semantics for `google`, `openai`, `anthropic`, and `codex-cli`.
- [x] Phase 4: Migrate `spawnAgent` and session title generation to runtime abstraction and PI-backed execution paths.
- [x] Phase 5: Preserve websocket/TUI stream compatibility by normalizing PI stream events into existing `model_stream_chunk` part contracts.
- [x] Phase 6: Flip default runtime to PI, update docs/config/protocol notes, and clean up direct AI SDK runtime wiring.
- [x] Add or update targeted regression tests for runtime selection, provider parity, stream mapping, subagent execution, and title generation.
- [x] Run targeted verification suites, then full `bun test`.

## Review
- Added `src/runtime/` with runtime boundary (`types.ts`) plus `aiSdkRuntime` and `piRuntime`; `src/agent.ts` now routes model execution through `createRuntime()` and keeps AI SDK override compatibility for existing tests.
- Added runtime selection/config support (`AgentConfig.runtime`, `AGENT_RUNTIME`, defaults `runtime: "pi"` in `config/defaults.json`) and exported saved-key resolution for provider-auth parity in PI runtime.
- Implemented PI provider/model/auth mapping for `openai`, `google`, `anthropic`, and `codex-cli` (including Codex OAuth refresh path), PI tool-schema bridging from Zod -> JSON Schema, and PI message bridging to existing `ModelMessage` history format.
- Migrated subsystem callers to runtime abstraction: `spawnAgent` uses runtime by default with legacy AI SDK path for injected test deps; session title generation uses runtime path for PI while preserving AI SDK structured-title compatibility path.
- Preserved stream contract by mapping PI stream/tool lifecycle events into existing normalized stream part types (`model_stream_chunk` compatibility retained in session pipeline/TUI/client reducers).
- Updated documentation (`docs/architecture.md`, `docs/websocket-protocol.md`) for runtime abstraction and runtime-agnostic stream raw parts.
- Added regression coverage: `test/runtime.selection.test.ts`, `test/runtime.pi-message-bridge.test.ts`, `test/runtime.pi-options.test.ts`, plus updates in `test/session-title-service.test.ts` and `test/config.test.ts`.
- Fixed surfaced regressions during verification:
  - `src/server/session/TurnExecutionManager.ts`: hoisted `lastStreamError` so catch-path classification uses in-scope stream error context.
  - Desktop test stability: expanded mocked `desktopCommands` exports in multiple desktop tests to avoid full-suite order-dependent missing-export failures.
- Verification:
  - `bun test test/runtime.selection.test.ts test/runtime.pi-message-bridge.test.ts test/runtime.pi-options.test.ts test/session-title-service.test.ts test/agent.test.ts test/agent.toolloop.test.ts test/spawnAgent.tool.test.ts test/config.test.ts test/server.model-stream.test.ts test/session.stream-pipeline.test.ts` -> **288 pass, 0 fail**
  - `bun test test/session.test.ts` -> **174 pass, 0 fail**
  - `bun test` -> **1686 pass, 2 skip, 0 fail**

---

# Task: Validate real production loop tool coverage for Google gemini-3.1-pro-preview-customtools

## Plan
- [x] Add a dedicated raw harness scenario/runs for Google `gemini-3.1-pro-preview-customtools` that require all built-in tools at least once across runs.
- [x] Run the scenario against real provider auth with production loop wiring and capture artifacts.
- [x] Fix any runtime regressions discovered while running the live loop.
- [x] Add/adjust regression tests where needed and run targeted suites.
- [x] Run full verification (`bun test`) and record outcomes.

## Review
- Added a new harness scenario, `google-customtools-tool-coverage`, in `scripts/run_raw_agent_loops.ts` and updated argument parsing/help + run-root naming to support selecting it.
- Scenario includes 4 Google runs on `gemini-3.1-pro-preview-customtools` covering all built-in tools: `ask`, `bash`, `edit`, `glob`, `grep`, `memory`, `notebookEdit`, `read`, `skill`, `spawnAgent`, `todoWrite`, `webFetch`, `webSearch`, `write`.
- Fixed a real harness validation bug discovered during live run: `requiredFirstNonTodoToolCall` was derived only from traced stream payloads, which can miss tool calls for some provider/tool traces. Added ordered `tool-log` extraction and used it as primary source (with traced fallback).
- Removed unnecessary first-call ordering enforcement from `gct-02-skill-bash`; kept required tool usage assertions.
- Fixed unrelated pre-existing red suite while validating: `createWebSearchTool()` now returns Anthropic provider-native `anthropic.tools.webSearch_20250305({})` for `provider: "anthropic"`, matching expected runtime/tool id.
- Live production loop verification (using saved Google auth from `~/.cowork/auth/connections.json`):
  - `bun scripts/run_raw_agent_loops.ts --scenario google-customtools-tool-coverage --report-only`
  - latest run root: `tmp/raw-agent-loop_google-customtools-tool-coverage_2026-02-24T17-16-23-673Z`
  - aggregated tool-log verification: `UNIQUE_TOOL_COUNT=14`
- Verification:
  - `bun test test/tools.test.ts test/repl.disconnect-send.test.ts` -> **154 pass, 0 fail**
  - `bun test` -> **1671 pass, 2 skip, 0 fail**

---

# Task: Loosen strict Zod validation around tool-call stream parsing

## Plan
- [x] Add tolerant server-event parsing for `model_stream_chunk` (non-object `part`, partial stream metadata defaults).
- [x] Add detailed parse diagnostics (`parseServerEventDetailed`) while keeping `safeParseServerEvent` compatibility.
- [x] Wire client socket diagnostics via optional `onInvalidEvent` and robust frame decoding (string/ArrayBuffer/ArrayBufferView/Blob/object).
- [x] Loosen tool-call ID handling across stream normalizers (numeric IDs + anonymous fallback IDs instead of empty strings).
- [x] Improve raw provider-event mapping resilience (`evt.rawPart` fallback + loose primitive text coercion).
- [x] Preserve structured array args in TUI tool-input lifecycle.
- [x] Keep sanitization defaults but add an explicit fuller mode (`rawPartMode: "full"` + `COWORK_MODEL_STREAM_RAW_MODE=full` hook).
- [x] Update protocol docs and regression tests for the new behavior.
- [x] Run targeted verification suites.

## Review
- Added `parseServerEventDetailed` + `ServerEventParseResult`/`ServerEventParseErrorReason` in `src/server/protocolEventParser.ts`, exported via `src/server/protocol.ts`.
- `model_stream_chunk` parsing now tolerates missing `turnId/index/provider/model` (defaults: `"unknown-turn"`, `-1`, `"unknown"`, `"unknown"`) and normalizes non-object `part` payloads to `{ value: <raw> }`.
- `AgentSocket` now supports optional invalid-event diagnostics (`onInvalidEvent`) and decodes binary/blob websocket frames before parsing.
- Server and client stream normalization now coerce numeric IDs, avoid empty-string tool IDs, and use deterministic anonymous IDs.
- Client stream mapper now performs looser primitive text coercion and uses `evt.rawPart` as a secondary fallback for provider raw event mapping.
- TUI tool-arg normalization now preserves parsed array payloads instead of forcing record-only shape.
- Added/updated regression coverage in:
  - `test/agentSocket.parse.test.ts`
  - `test/server.model-stream.test.ts`
  - `test/tui.model-stream.test.ts`
- Updated `docs/websocket-protocol.md` validation + `model_stream_chunk` notes for diagnostics/defaults/part normalization/raw mode.
- Verification:
  - `bun test test/agentSocket.parse.test.ts test/server.model-stream.test.ts test/tui.model-stream.test.ts test/model-stream.provider-loop.test.ts test/session.stream-pipeline.test.ts`
  - `bun test test/protocol.test.ts`
  - `bun test` -> **1666 pass, 2 skip, 0 fail**

---

# Task: Fix PR review regressions (desktop persistence, auth resilience, protocol coverage)

## Plan
- [x] Restore desktop persisted-state backward compatibility on load while keeping save-time safety.
- [x] Make desktop transcript hydration resilient to malformed lines and avoid thread selection hard-failures.
- [x] Restore legacy transcript reasoning aliases (`assistant_reasoning`, `reasoning_summary`) in feed mapping.
- [x] Align desktop persisted-state IPC validation with runtime expectations.
- [x] Relax Codex device OAuth response parsing to accept forward-compatible extra fields.
- [x] Make MCP auth-store reads recover from malformed/invalid credential files instead of failing closed.
- [x] Make CLI state loading recover from malformed/invalid JSON schema drift.
- [x] Change `set_model` / `set_enable_mcp` persistence failures to fail-open runtime updates with surfaced non-fatal errors.
- [x] Expand parser/decode regression coverage (server-event fixture parsing + binary websocket decode path).
- [x] Update websocket protocol docs for strict server-event parsing behavior and persistence-failure semantics.
- [x] Run targeted and full verification (`bun test ...`, `bun test`).

## Review
- Desktop persistence now sanitizes malformed state, recovers from invalid `state.json` JSON, and skips malformed transcript lines.
- Thread selection no longer hard-fails on transcript read errors, and legacy reasoning aliases are mapped correctly.
- Desktop persisted-state schemas now default workspace/session booleans (`defaultEnableMcp`, `yolo`, `developerMode`, `showHiddenFiles`) for stronger IPC/runtime alignment.
- `set_model` / `set_enable_mcp` now apply runtime updates even when persistence fails and surface non-fatal `internal_error` events.
- MCP auth-store and CLI state-store reads now recover from malformed files instead of failing closed.
- Added/updated regression coverage including binary decode parsing, server-event fixtures, desktop state/transcript recovery, and desktop schema defaults.
- Documentation updated for server-event parsing behavior and `server_hello.protocolVersion` (`7.0`).
- Verification:
  - targeted suites for affected areas
  - full suite: `bun test` → **1656 pass, 2 skip, 0 fail**

---

# Task: Preserve webSearch alias compatibility and harden legacy snapshot import

## Plan
- [x] Restore compatibility alias support in `src/tools/webSearch.ts` for `q`, `searchQuery`, `text`, and `prompt`.
- [x] Preserve strict input handling while allowing provider-native compatibility extras (`mode`, `dynamicThreshold`).
- [x] Add `webSearch` regression coverage for alias-based inputs plus compatibility extras.
- [x] Make `importLegacySnapshots()` skip unreadable legacy entries instead of aborting migration.
- [x] Add SessionDb regression coverage proving unreadable `.json` entries are skipped while valid snapshots import.
- [x] Run verification (`bun test test/tools.test.ts`, `bun test test/session-db.test.ts`, `bun test`).

## Review
- `webSearch` input parsing now accepts legacy alias keys and resolves the first provided query field in priority order: `query`, `q`, `searchQuery`, `text`, `prompt`.
- The schema remains `.strict()` and now explicitly allows compatibility extras `mode` and `dynamicThreshold` so provider-native payloads are not rejected before execution.
- Added regression test `accepts compatibility query aliases and provider-native extra keys` in `test/tools.test.ts`.
- `importLegacySnapshots()` now wraps per-file reads in `try/catch` so unreadable files are skipped and migration proceeds.
- Added regression test `skips unreadable legacy snapshot entries while importing valid ones` in `test/session-db.test.ts`.
- Verification:
  - `bun test test/tools.test.ts`
  - `bun test test/session-db.test.ts`
  - `bun test`

---

# Task: Handle invalid connection store without aborting auth flows

## Plan
- [x] Confirm the current `readConnectionStore()` error behavior for malformed and legacy-shape `connections.json`.
- [x] Make `readConnectionStore()` treat invalid JSON/schema as recoverable and return an empty store instead of throwing.
- [x] Add regression tests proving `connectProvider()` can recover from invalid store files.
- [x] Add regression tests proving `getProviderStatuses()` still returns statuses when store JSON/schema is invalid.
- [x] Run verification (`bun test test/connect.test.ts`, `bun test test/providerStatus.test.ts`, `bun test`).

## Review
- Added a dedicated `ConnectionStoreParseError` in `/Users/mweinbach/Projects/agent-coworker/src/store/connections.ts` so parse/schema failures are distinguishable from filesystem failures.
- `readConnectionStore()` now treats invalid `connections.json` content as recoverable and falls back to an empty in-memory store, preserving normal `/connect` and provider-status flows.
- Filesystem failures (other than `ENOENT`) still throw, so permission and IO issues remain visible.
- Added regression test `recovers from malformed connection store JSON when saving a provider key` in `/Users/mweinbach/Projects/agent-coworker/test/connect.test.ts`.
- Added regression test `treats legacy-shaped connection store as empty instead of throwing` in `/Users/mweinbach/Projects/agent-coworker/test/providerStatus.test.ts`.
- Verification:
  - `bun test test/connect.test.ts`
  - `bun test test/providerStatus.test.ts`
  - `bun test`

---

# Task: Keep MCP/session loading resilient to malformed JSON

## Plan
- [x] Make `loadMCPConfigRegistry()` best-effort by turning per-layer parse failures into file-level parse warnings.
- [x] Ensure malformed MCP layers do not block resolution of valid layers in snapshot/runtime paths.
- [x] Make `listPersistedSessionSnapshots()` skip malformed/invalid snapshot files instead of throwing.
- [x] Add regression coverage in `test/mcp.config-registry.test.ts` and `test/session-store.test.ts`.
- [x] Run verification (`bun test test/mcp.config-registry.test.ts`, `bun test test/session-store.test.ts`, `bun test`).

## Review
- `readLayer()` in `/Users/mweinbach/Projects/agent-coworker/src/mcp/configRegistry/layers.ts` now catches parse/schema failures per file, records `file.parseError`, and keeps loading remaining layers.
- `loadMCPConfigRegistry()` now emits warning entries for malformed layer files while continuing to merge valid system/user/workspace servers.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/test/mcp.config-registry.test.ts` proving malformed workspace JSON no longer aborts registry loading and warnings/parse metadata are populated.
- `listPersistedSessionSnapshots()` in `/Users/mweinbach/Projects/agent-coworker/src/server/sessionStore.ts` now skips malformed JSON and invalid snapshot shapes per file instead of failing the entire list operation.
- Added regression coverage in `/Users/mweinbach/Projects/agent-coworker/test/session-store.test.ts` proving corrupt session files are skipped while valid snapshots remain listable/sorted.
- Verification:
  - `bun test test/mcp.config-registry.test.ts`
  - `bun test test/session-store.test.ts`
  - `bun test`

---

# Task: Fix review regressions in stream event dispatch and anonymous tool IDs

## Plan
- [x] Stop classifying consumer `onEvent` exceptions as `invalid_envelope` in `AgentSocket`.
- [x] Keep anonymous stream fallback IDs stable for a whole turn in `TurnExecutionManager`.
- [x] Ensure id-less `tool_input_*`, `tool_call`, and `tool_result` chunks share one fallback key path.
- [x] Add regression coverage for socket callback exception bubbling.
- [x] Add regression coverage for id-less tool lifecycle key correlation.
- [x] Run verification (`bun test` targeted suites + full suite).

## Review
- `src/client/agentSocket.ts` now limits `invalid_envelope` handling to decode/parse failures; valid event dispatch (`this.onEvent(evt)`) is outside that catch so consumer exceptions propagate instead of being suppressed.
- `src/server/session/TurnExecutionManager.ts` now uses `fallbackIdSeed: turnId` (not per-part index), making anonymous fallback IDs stable for the whole streamed turn.
- `src/server/modelStream.ts` now uses `toolCallId()` for `tool-input-start`, `tool-input-delta`, and `tool-input-end` IDs so id-less tool input/call/result chunks share one fallback call key.
- Added runtime regression tests in `test/agentSocket.runtime.test.ts` covering invalid envelope diagnostics and non-swallowed `onEvent` exceptions.
- Added stream lifecycle regression in `test/session.stream-pipeline.test.ts` proving id-less `tool_input_*`, `tool_call`, and `tool_result` chunks share the same fallback key.
- Updated `test/server.model-stream.test.ts` expectations for tool-input anonymous ID fallback behavior.
- Verification:
  - `bun test test/agentSocket.runtime.test.ts test/server.model-stream.test.ts test/session.stream-pipeline.test.ts`
  - `bun test` -> **1671 pass, 2 skip, 0 fail**
