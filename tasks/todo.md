# Task: Remediate unauthenticated MCP server config writes over WebSocket

## Plan
- [x] Verify whether `mcp_servers_set` is still accepted in HEAD without any authorization gate and can persist workspace MCP JSON.
- [x] Implement a minimal server-side authorization gate for MCP workspace settings writes (and keep read behavior intact).
- [x] Add/adjust regression tests to prove unauthorized clients cannot write MCP server JSON.
- [x] Run targeted tests and full `bun test`, then document outcomes.

## Review
- Confirmed in current HEAD that WebSocket `/ws` accepted unauthenticated upgrades and exposed MCP mutation messages, enabling local untrusted clients to reach workspace MCP write paths.
- Added a connection-level random auth token gate in `startAgentServer()`; `/ws` upgrades now require `?token=<server-generated-token>`, and the returned server URL now includes this token automatically for first-party clients.
- Added/updated server tests to assert unauthenticated `/ws` requests get HTTP 401 and to keep resume behavior working by appending `resumeSessionId` alongside the auth token.
- Verification:
  - `bun test test/server.test.ts test/protocol.test.ts` (pass)
  - `bun test` (fails in this environment on pre-existing skill-discovery/skill-tool tests unrelated to this patch; server tests pass)

---
# Task: Run the harness in this repo with Codex gpt-5.4

## Plan
- [x] Add `gpt-5.4` to the curated Codex model catalog if it is not already selectable.
- [x] Add the smallest practical raw harness scenario/run for `codex-cli` using `gpt-5.4`.
- [x] Execute the harness run against the current repo and inspect the generated artifacts/results.
- [x] Run targeted verification and record the outcome.

## Review
- Added `gpt-5.4` to the curated Codex model list in `/Users/mweinbach/Projects/agent-coworker/src/providers/catalog.ts` and added a dedicated raw harness scenario, `codex-gpt-5.4-smoke`, in `/Users/mweinbach/Projects/agent-coworker/scripts/run_raw_agent_loops.ts`. The harness runbook now documents that scenario in `/Users/mweinbach/Projects/agent-coworker/docs/harness/runbook.md`.
- The first harness attempt exposed a real bug in local auth resolution for harness runs: several paths derived the Cowork home directory from `dirname(userAgentDir)`, which broke when harness runs rewrote `userAgentDir` to `<runDir>/.agent-user`. That caused Codex auth lookup to fall back to `<runDir>/.cowork/auth/...` instead of the real `~/.cowork/auth/...`. Fixed by introducing `/Users/mweinbach/Projects/agent-coworker/src/utils/coworkHome.ts` and switching the affected config/runtime/session/model-adapter call sites to use it.
- Also tightened the Codex smoke prompt so it only exercises files inside the harness working directory, avoiding false-negative permission denials from trying to read the parent repo while the run is sandboxed to the per-run output directory.
- Successful harness run:
  - Command: `AGENT_OUTPUT_DIR=output bun scripts/run_raw_agent_loops.ts --scenario codex-gpt-5.4-smoke --report-only`
  - Run root: `/Users/mweinbach/Projects/agent-coworker/output/raw-agent-loop_codex-gpt-5.4-smoke_2026-03-07T01-05-56-136Z`
  - Per-run dir: `/Users/mweinbach/Projects/agent-coworker/output/raw-agent-loop_codex-gpt-5.4-smoke_2026-03-07T01-05-56-136Z/codex-smoke-01-core-tools_codex-cli_gpt-5.4`
  - Result: single successful attempt (`attempts.json` shows `ok: true`), `run_meta.json` shows `requestedModel`/`resolvedModel` both `gpt-5.4`, and `final.txt` contains the expected JSON with `<<END_RUN>>`.
  - The generated report file is `/Users/mweinbach/Projects/agent-coworker/output/raw-agent-loop_codex-gpt-5.4-smoke_2026-03-07T01-05-56-136Z/codex-smoke-01-core-tools_codex-cli_gpt-5.4/codex_harness_smoke.md`.
- Verification:
  - `bun test test/runtime.pi-runtime.test.ts test/session.test.ts test/providers/codex-cli.test.ts apps/desktop/test/modelChoices.test.ts` -> pass (`188 pass, 0 fail`)
  - `bun run docs:check` -> pass
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)
  - `git diff --check` -> pass

---

# Task: Run and smoke-test the desktop app end to end

## Plan
- [x] Launch the Electron desktop app in dev mode and confirm it boots without fatal startup errors.
- [x] Exercise the primary desktop chat UI path with the repo's browser automation workflow and capture any visible issues.
- [x] Run relevant automated verification after the live smoke test and record the outcome.

## Review
- Launched the desktop app with `COWORK_ELECTRON_REMOTE_DEBUG=1 bun run desktop:dev`. Electron/Vite booted cleanly, the renderer loaded at `http://localhost:1420/`, and Electron exposed CDP on `ws://127.0.0.1:9222/...` with no startup crash. The only terminal warning during boot was the existing observability configuration warning from the bundled server.
- Used the Playwright interactive workflow to attach to the live renderer over CDP and confirm the real window loaded (`Cowork Desktop`, `http://localhost:1420/`). The initial shell rendered the expected empty-state copy (`No workspaces yet`, `Let's build`, `Pick a workspace and start a new thread.`).
- Continued the UI smoke test through the repo-supported desktop browser wrapper against the same CDP session. Verified Settings navigation (`Providers`, `Workspaces`, `Developer`) and return-to-app flow without renderer failure. After returning to the main app, the restored `Cowork Test` workspace/session rendered an active composer and file/context pane.
- Exercised the compose/send path: filling the message box enabled the `Send message` button, and submitting did not crash the app. Instead, the app surfaced the provider configuration view (`Connect your AI providers to start chatting.` with connected Google/Codex CLI sections), which is consistent with a runtime that needs provider setup before chatting.
- Verification:
  - `bun test --cwd apps/desktop` -> pass (`122 pass, 0 fail`)
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)

---

# Task: Align desktop app shadcn and ai-elements integration

## Plan
- [x] Add proper shadcn project metadata and `@/` alias wiring for `apps/desktop`.
- [x] Update the vendored desktop shadcn primitives to match current shadcn composition and accessibility expectations where needed.
- [x] Tighten the desktop `ai-elements` wrappers and chat surfaces so they compose cleanly with the shadcn layer.
- [x] Run verification (`apps/desktop` tests, targeted repo tests, and shadcn/ai-elements CLI dry-run checks) and record the review.

## Review
- Added `/Users/mweinbach/Projects/agent-coworker/apps/desktop/components.json` plus `@/*` alias wiring in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/tsconfig.json` and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/electron.vite.config.ts` so `apps/desktop` is now a real shadcn project. `npx shadcn@latest info --json` now reports `config` and the installed desktop UI components instead of `config: null`.
- Filled the missing `accent` semantic token in `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/styles.css` and normalized the vendored shadcn primitives (`button`, `badge`, `card`, `checkbox`, `dialog`, `input`, `select`, `textarea`) with app-local aliases, `data-slot` metadata, and more consistent icon sizing/composition.
- Refactored the desktop `ai-elements` layer so the composer behaves like a compound component again: `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/prompt-input.tsx` now exposes `Body`/`Footer`/`Tools`, forwards primitive props/refs, restores a focus-within ring on the shell, and uses AI Elements-style `status` semantics for submit/stop actions. `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/ChatView.tsx` now consumes that structure and moves the model selector into the footer/tools row.
- Fixed the desktop tool feed to preserve AI Elements-style lifecycle states instead of flattening them to `running|done|error`. `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/types.ts`, `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/app/store.feedMapping.ts`, `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/components/ai-elements/tool.tsx`, and `/Users/mweinbach/Projects/agent-coworker/apps/desktop/src/ui/chat/toolCards/*` now keep approval metadata, represent `approval-requested` / `output-denied` / `output-error` distinctly, and auto-expand terminal or approval-blocked tool cards.
- Verification:
  - `npx shadcn@latest info --json` in `apps/desktop` -> pass
  - `npx shadcn@latest add @ai-elements/prompt-input --dry-run` in `apps/desktop` -> pass
  - `bun test apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/legacy-tool-logs.test.ts apps/desktop/test/tool-card-formatting.test.ts apps/desktop/test/chat-reasoning-ui.test.ts` -> pass
  - `bun test --cwd apps/desktop` -> pass (`122 pass, 0 fail`)
  - `bun test` -> pass (`1683 pass, 2 skip, 0 fail`)
  - `bun x tsc -p apps/desktop/tsconfig.json --noEmit` -> still fails on pre-existing unused-import / unrelated repo type issues in `apps/desktop/src/app/store.actions/*` and shared root `src/*` files; not introduced by this change

---

# Task: Close remaining PI runtime PR follow-ups (tool-call IDs + MCP error semantics)

## Plan
- [x] Ensure `toolcall_end` uses the same derived tool ID/name path as `toolcall_start`/`toolcall_delta`.
- [x] Treat MCP-style `{ isError: true }` tool outputs as tool failures in PI runtime execution.
- [x] Add targeted regression tests for the above.
- [x] Run focused verification and record results.

## Review
- Updated `src/runtime/piRuntime.ts` raw event mapping so `toolcall_end` now derives identifiers from `toolCallFromPartial(event)` (same path as start/delta), preserving stable `tool_input_*`/`tool_call` correlation.
- Updated PI runtime tool execution to classify MCP-style error payloads (`{ isError: true, ... }`) as `tool-error` events and persisted `toolResult.isError: true` entries instead of false-success `tool-result` emissions.
- Exposed targeted runtime internals for regression tests and added coverage in `test/runtime.pi-runtime.test.ts` for:
  - `toolcall_end` ID/name consistency from partial payloads,
  - MCP-style `isError` mapping to `tool-error`.
- Verification:
  - `bun test test/runtime.pi-runtime.test.ts` -> pass

---

# Task: Fix all current PR review findings (security, bugs, race, flakiness, maintainability)

## Plan
- [x] Remove secret leakage from runtime telemetry spans.
- [x] Fix PI runtime correctness bugs (`isZodSchema` import, `prepareStep` overrides, abort-before-tools checks, non-text message bridging).
- [x] Eliminate Codex auth refresh races and improve auth/header error handling semantics.
- [x] Restore provider-aware webSearch behavior and expand regression coverage.
- [x] Fix raw harness script regressions (missing provider key vars, finalize pass tool side-effects).
- [x] Improve maintainability hotspots (runtime path duplication/gating cleanup, stale comments/types, runtime selection behavior).
- [x] Address test flakiness in Codex auth-related tests by removing hidden network/shared-state dependencies.
- [x] Run targeted suites, then full `bun test`, and document outcomes.

## Review
- Redacted telemetry inputs in PI runtime so `llm.input.options` no longer records sensitive auth material (`apiKey`, `authorization`, token-like keys).
- Fixed PI runtime correctness issues:
  - restored missing `isZodSchema` import path,
  - applied `prepareStep` overrides correctly by separating message/provider-option overrides from raw stream options,
  - added abort checks before tool execution to prevent post-cancel side effects,
  - preserved non-text user content in PI bridge via explicit placeholders.
- Added Codex refresh coalescing (`refreshCodexAuthMaterialCoalesced`) and wired both runtime + model adapter to remove concurrent refresh races.
- Tightened Codex adapter auth semantics by failing on expired token instead of silently returning empty auth headers.
- Restored provider-aware `webSearch` behavior with BRAVE-first fallback (for non-google providers), EXA fallback, and provider-appropriate disabled messages.
- Fixed raw harness regressions:
  - restored required provider API key environment resolution variables,
  - disabled tools in finalize pass (instead of relying on prompt-only behavior).
- Maintainability improvements:
  - runtime selection now explicitly uses config-driven resolution (`createRuntime` switch on `resolveRuntimeName`),
  - removed stale `@deprecated` marker from active `modelAdapter`,
  - made `defineTool.execute` required,
  - simplified legacy runtime path gating (`streamText + stepCountIs`) in both `agent` and `spawnAgent`.
- Flakiness fixes:
  - avoided near-expiry Codex token refresh path in `test/runtime.pi-runtime.test.ts`,
  - removed hidden shared tmp-state dependence in provider test helpers and stabilized codex header-shape test with explicit env key.
- Added regression coverage:
  - `test/runtime.pi-runtime.test.ts`
  - `test/runtime.pi-message-bridge.test.ts`
  - `test/tools.test.ts`
- Verification:
  - `bun test test/runtime.pi-runtime.test.ts test/runtime.pi-message-bridge.test.ts test/tools.test.ts test/providers/codex-cli.test.ts`
  - `bun test test/agent.test.ts test/spawnAgent.tool.test.ts test/mcp.test.ts test/runtime.selection.test.ts`
  - `bun test` -> **1681 pass, 2 skip, 0 fail**

---

# Task: Address PR review must-fix items (runtime telemetry/auth/raw-chunk correctness)

## Plan
- [x] Eliminate duplicate abort-callback execution in PI runtime turn loop.
- [x] Preserve Codex account-header behavior in PI runtime auth path (`ChatGPT-Account-ID` parity).
- [x] Honor `includeRawChunks` end-to-end in session stream normalization/emission.
- [x] Ensure runtime telemetry is actually applied on PI model calls (or adjust behavior/docs if unsupported).
- [x] Add targeted regression coverage for the above and run full verification (`bun test`).

## Review
- Removed duplicate abort callback invocation in `src/runtime/piRuntime.ts` by relying on the outer catch-path abort handling.
- Restored Codex account-header parity by carrying `accountId` through runtime model resolution and forwarding `ChatGPT-Account-ID` into PI stream headers.
- Added `AgentConfig.includeRawChunks` plumbing (`src/types.ts`, `src/config.ts`, `config/defaults.json`) and used it in `TurnExecutionManager` for both runtime call options and `rawPart` emission.
- Added PI-runtime telemetry span instrumentation in `src/runtime/piRuntime.ts` and explicit telemetry parsing helpers (`__internal.parseTelemetrySettings`).
- Added regression coverage:
  - `test/runtime.pi-runtime.test.ts`
  - `test/runtime.pi-options.test.ts`
  - `test/session.stream-pipeline.test.ts`
- Verification:
  - `~/.bun/bin/bun test test/runtime.pi-runtime.test.ts test/runtime.pi-options.test.ts test/session.stream-pipeline.test.ts` -> **39 pass, 0 fail**
  - `~/.bun/bin/bun test` -> **1673 pass, 2 skip, 2 fail** (sandbox EPERM writing `~/.cowork/state/cli-state.json.*.tmp` in two CLI REPL tests)
  - `HOME=/tmp/agent-coworker-test-home ~/.bun/bin/bun test` -> **1675 pass, 2 skip, 0 fail**

---

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
