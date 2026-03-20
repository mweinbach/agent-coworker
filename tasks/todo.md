# Decouple Google Provider from PI Runtime → Google Interactions API

## Goal
Move Google/Gemini from the PI runtime (`@mariozechner/pi-ai`) to its own dedicated runtime
using the Google Interactions API directly, mirroring how OpenAI uses its own Responses API runtime.

## Architecture Summary

**Current state:** Google → PI runtime → `@mariozechner/pi-ai` library → Gemini API
**Target state:** Google → Google Interactions runtime → `@google/genai` SDK → Interactions API

Mirrors: OpenAI → OpenAI Responses runtime → `openai` SDK → Responses API

## Plan

### Phase 1: Foundation
- [ ] Install `@google/genai` SDK
- [ ] Add `"google-interactions"` to `RUNTIME_NAMES` in `src/types.ts`
- [ ] Wire routing: Google provider → `google-interactions` runtime in `normalizeRuntimeNameForProvider()`

### Phase 2: Model Resolution
- [ ] Create `src/runtime/googleInteractionsModel.ts` — resolve Google model metadata (context window, max tokens, capabilities) without PI dependency, mirroring `openaiResponsesModel.ts`

### Phase 3: Native API Step
- [ ] Create `src/runtime/googleNativeInteractions.ts` — direct API call to Google Interactions endpoint with streaming, tool calling, thinking support. Mirrors `openaiNativeResponses.ts`.
  - Build request: model, system_instruction, input (messages), tools, generation_config (thinking, temperature), stream, previous_interaction_id
  - Process SSE stream: interaction.start, content.delta (text, thought, function_call), content.stop, interaction.complete
  - Extract assistant response, usage, interaction ID for continuation
  - Handle function_result submission for tool call loops

### Phase 4: Runtime Wrapper
- [ ] Create `src/runtime/googleInteractionsRuntime.ts` — multi-step turn loop with tool execution. Mirrors `openaiResponsesRuntime.ts`.
  - Step loop with tool call → execute → feed result cycle
  - Emit stream parts (start-step, finish-step, tool-result, tool-error)
  - Support prepareStep (Google thought signature replay)
  - Return RuntimeRunTurnResult with text, reasoningText, responseMessages, usage

### Phase 5: Integration
- [ ] Update `src/runtime/index.ts` — add `google-interactions` case to `createRuntime()`
- [ ] Remove Google-specific code from PI runtime (`resolvePiModel`, `buildPiStreamOptions`)
- [ ] Update `src/agent.ts` — keep `buildGooglePrepareStep` wiring (still needed for thought signatures)
- [ ] Update `RuntimeModelRawEvent` format type to include `"google-interactions-v1"`

### Phase 6: Provider Options
- [ ] Create `src/runtime/googleInteractionsStreamOptions.ts` — map providerOptions (thinkingConfig, temperature, toolChoice) to Interactions API generation_config format

### Phase 7: Tests
- [ ] Create `test/runtime/googleInteractions.test.ts` — unit tests for the new runtime
- [ ] Update `test/providers/google.test.ts` if needed
- [ ] Run full test suite to ensure no regressions

### Phase 8: Cleanup
- [ ] Verify Google models still work end-to-end
- [ ] Update any PI runtime references that assumed Google would be there

## Review Execution 2026-03-18

- [x] Review diff vs `f87fd5fb6af644cbccb1f61a6864b4453bf69a2f` for Google Interactions runtime/provider regressions
- [x] Exclude provider-native Google Maps support changes
- [x] Exclude Google interaction state persistence changes
- [x] Cross-check findings with parallel explorer/reviewer/docs passes
- [x] Record only discrete, line-supported bugs

## Implementation Follow-up 2026-03-18

### Plan
- [x] Remove Google Maps support from runtime, protocol/schema, desktop/TUI, and docs surfaces
- [x] Persist Google Interactions continuation state (`interactionId`) across turns and snapshots
- [x] Verify Google continuation behavior, repo tests, typecheck, and production builds

### Notes
- Official Gemini Interactions docs now document both `previous_interaction_id` server-side state and a `google_maps` built-in tool.
- The pinned local SDK in this branch is `@google/genai@1.43.0`, and its TypeScript surface is internally inconsistent: `BaseCreateModelInteractionParams` includes `previous_interaction_id`, but the raw `Tool_2` union only exposes `google_search` and `url_context` while `GoogleMaps` exists as a separate interface.
- Product direction for this branch is now explicit: remove Google Maps entirely and keep only Google Search + URL Context native tools.

### Verification
- [x] `~/.bun/bin/bun test test/runtime.google-interactions.test.ts`
- [x] `~/.bun/bin/bun test test/session.test.ts`
- [x] `~/.bun/bin/bun test test/shared/openaiCompatibleOptions.test.ts test/protocol.test.ts test/server.test.ts test/displayCitationMarkers.test.ts test/tools.test.ts apps/desktop/test/tool-card-formatting.test.ts apps/desktop/test/workspaces-page.test.ts`
- [x] `~/.bun/bin/bun run typecheck`
- [x] `~/.bun/bin/bun test`
- [x] `~/.bun/bin/bun run build:server-binary`
- [x] `~/.bun/bin/bun run build:desktop-resources`
- [x] `~/.bun/bin/bun run desktop:build`

## Desktop Draft Thread Persistence 2026-03-19

### Plan
- [x] Trace why desktop `newThread()` was creating/persisting sessions before the user sent a message
- [x] Keep empty new threads renderer-local as drafts until the first non-empty user message promotes them into a real session
- [x] Add regressions for local draft behavior, first-message promotion, and reconnect/persistence edge cases
- [x] Re-run repo verification and production desktop/server builds

### Notes
- Root cause was eager desktop thread creation: clicking around the app created a full thread record/session path even when the composer stayed empty, so blank entries accumulated in persisted state.
- The fix makes the default desktop new-thread path a local `draft` record, dedupes to one draft per workspace, skips socket/server startup for that draft, and filters drafts out of persisted desktop state until the first real message is sent.
- Existing reconnect/transcript work on this branch already touched thread hydration paths, so the fix also keeps transcript-only fallback threads from reconnecting or fetching harness snapshots unless there is real persisted session content to restore.

### Verification
- [x] `~/.bun/bin/bun run typecheck`
- [x] `~/.bun/bin/bun test apps/desktop/test/thread-reconnect.test.ts`
- [x] `~/.bun/bin/bun test apps/desktop/test/settings-nav.test.ts apps/desktop/test/protocol-v2-events.test.ts apps/desktop/test/workspace-mcp-editor.test.ts apps/desktop/test/workspace-settings-sync.test.ts apps/desktop/test/thread-reconnect.test.ts`
- [x] `~/.bun/bin/bun test`
- [x] `~/.bun/bin/bun run build:server-binary`
- [x] `~/.bun/bin/bun run build:desktop-resources`
- [x] `~/.bun/bin/bun run desktop:build`
