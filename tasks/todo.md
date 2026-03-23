# Task Plan

## Fix Duplicate Final JSON-RPC Assistant Content

- [x] Inspect the latest duplicated live session in `~/.cowork/sessions.db` and confirm the duplicate comes from the final cumulative JSON-RPC `assistant_message` path rather than a replay-only issue.
- [x] Patch the live/journal JSON-RPC projectors so cumulative final assistant payloads are suppressed when streamed assistant history only differs by boundary whitespace, and ignore whitespace-only assistant segments.
- [x] Harden desktop transcript/replay assistant dedupe to use exact streamed assistant history rather than guessed paragraph joins, add focused regressions, and rerun the affected server/desktop verification slices plus `bun run typecheck`.

## Fix Duplicate Final JSON-RPC Assistant Content Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now drop whitespace-only assistant segments and suppress final cumulative assistant payloads when they only differ from streamed content by leading boundary whitespace, which stops the live duplicate-answer append after segmented streaming.
- `src/server/jsonrpc/threadReadProjector.ts` now drops older cumulative assistant duplicates during replay, so already-bad JSON-RPC journal rows no longer re-duplicate the same answer on reconnect when the only difference was boundary whitespace.
- `apps/desktop/src/app/store.feedMapping.ts` now dedupes merged `assistant_message` payloads against exact per-turn streamed assistant history instead of reconstructing the history from feed rows with synthetic paragraph separators, which keeps multi-step streamed answers and source cards from rendering twice.
- Added regressions in `test/jsonrpc.projectors.test.ts`, `test/jsonrpc.thread-read-projector.test.ts`, and `apps/desktop/test/store-feed-mapping.test.ts`.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts test/jsonrpc.thread-read-projector.test.ts apps/desktop/test/store-feed-mapping.test.ts apps/desktop/test/protocol-v2-events.test.ts` and `bun run typecheck`.

## Fix Live JSON-RPC Follow-Up Activity Streaming

- [x] Confirm the refresh view is already correct and isolate the remaining defect to the desktop live JSON-RPC reducer rather than the replay/journal projector.
- [x] Patch the live reducer so reused raw `item/agentMessage/delta` ids are segmented into distinct assistant feed items whenever streamed reasoning or tool activity resumes within the same turn.
- [x] Add a focused live desktop regression for repeated raw assistant ids across reasoning/tool follow-up steps, then rerun the affected desktop verification slice plus `bun run typecheck`.

## Fix Live JSON-RPC Follow-Up Activity Streaming Review

- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now tracks occurrence-stable live assistant stream ids per raw JSON-RPC assistant item id, so follow-up turns no longer keep one assistant feed item open across multiple reasoning/tool phases.
- The live reducer now closes the current assistant segment when streamed reasoning starts/deltas or tool activity begins/completes, which makes the live feed match the already-correct post-refresh snapshot ordering for assistant -> reasoning/tool -> assistant follow-up steps.
- `apps/desktop/test/protocol-v2-events.test.ts` now asserts the interleaved follow-up sequence while the turn is still streaming and verifies that the final aggregate `item/completed` assistant payload does not append a duplicate answer.
- Verification passed with `bun test apps/desktop/test/protocol-v2-events.test.ts` and `bun run typecheck`.

## Fix Follow-Up JSON-RPC Assistant Segments

- [x] Inspect the latest affected session in `~/.cowork/sessions.db` and confirm the remaining live-only bug is caused by the server JSON-RPC projector collapsing multiple assistant segments in one turn onto a single `agentMessage` item.
- [x] Patch both JSON-RPC projector paths so assistant segments close before follow-up reasoning/tool phases and restart with a fresh assistant item when output resumes within the same turn.
- [x] Add focused regressions for reused assistant stream ids across interleaved reasoning in both live notification and journal projection paths, then rerun the affected projector, desktop JSON-RPC, thread-read, and typecheck verification slices.

## Fix Follow-Up JSON-RPC Assistant Segments Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` no longer treat an entire turn as one long `agentMessage` item. Assistant text now closes before reasoning/tool follow-up phases and resumes on a fresh assistant item when output continues later in the same turn.
- The projector now preserves intra-turn ordering even when assistant output reuses the same underlying stream id or when the final legacy `assistant_message` event arrives with cumulative text for the whole turn.
- `test/jsonrpc.projectors.test.ts` now covers the exact failing shape: assistant output, reasoning, then more assistant output in the same turn with a reused stream id.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts`, `bun test test/jsonrpc.thread-read-projector.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Fix Live JSON-RPC Interleaved Reasoning Order

- [x] Reproduce the streaming-only ordering bug where a turn emits multiple assistant segments with completed-only reasoning between them and confirm replay-on-reopen is already correct.
- [x] Patch the desktop shared JSON-RPC reducer so `item/agentMessage/delta` keeps the real item id, distinct assistant segments do not collapse onto one synthetic stream key, and completed-only reasoning only anchors ahead of an assistant item that is still streaming.
- [x] Add a focused desktop JSON-RPC regression for `assistant -> reasoning -> tool -> assistant` ordering and rerun the affected desktop verification slice.

## Fix Live JSON-RPC Interleaved Reasoning Order Review

- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now forwards the JSON-RPC `itemId` on `item/agentMessage/delta`, so multiple assistant items in one turn no longer share the same fallback `text:0` stream key while streaming.
- The same reducer now distinguishes completed-only reasoning that belongs ahead of an in-flight assistant item from reasoning that occurs after an already completed intermediate assistant message, preserving live interleaved `assistant -> reasoning -> tool -> assistant` ordering.
- `apps/desktop/src/app/store.feedMapping.ts` now tracks which assistant stream keys have already completed so the live reducer can anchor only against an actually in-flight assistant item.
- Verification passed with `bun test apps/desktop/test/protocol-v2-events.test.ts`.

## Fix JSON-RPC Replay For PI/OpenCode Providers

- [x] Inspect an affected `opencode-go` session in `~/.cowork/sessions.db` and compare the snapshot feed, JSON-RPC journal, and persisted raw stream data to isolate whether the remaining ordering bug is provider-specific or a shared replay issue.
- [x] Patch the shared JSON-RPC projector path so repeated stream/tool ids within one turn get distinct item ids and late aggregate reasoning from PI/OpenCode providers is dropped when it only repeats streamed reasoning.
- [x] Patch `thread/read` journal replay so older journals that reused reasoning/tool item ids are disambiguated on read and preserve chronological order.
- [x] Add focused regressions for repeated PI reasoning/tool ids plus late aggregate reasoning across the full PI-provider family, then rerun the JSON-RPC projector, thread-read, desktop JSON-RPC, runtime-selection, and typecheck verification slices.

## Fix JSON-RPC Replay For PI/OpenCode Providers Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now assign occurrence-stable item ids per turn/stream key for repeated reasoning and tool lifecycles, so PI/OpenCode providers can reuse `s0` or fallback tool ids across steps without collapsing later items onto the first occurrence.
- The same projector path now drops the late aggregate `reasoning` event emitted after PI/OpenCode turns when it only repeats the already-streamed reasoning text, preventing reasoning from appearing below the final assistant reply.
- `src/server/jsonrpc/threadReadProjector.ts` now disambiguates older repeated journal item ids on replay and drops late aggregate reasoning items that only repeat earlier streamed reasoning, so already-persisted PI/OpenCode journals preserve chronology without replaying the old reasoning-after-answer artifact.
- `test/jsonrpc.projectors.test.ts` and `test/runtime.selection.test.ts` now explicitly cover the full PI-provider set: `anthropic`, `baseten`, `together`, `nvidia`, `lmstudio`, `opencode-go`, and `opencode-zen`.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts`, `bun test test/jsonrpc.thread-read-projector.test.ts`, `bun test test/runtime.selection.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Fix JSON-RPC Gemini Reasoning and Tool Projection

- [x] Inspect the affected Gemini session in `~/.cowork/sessions.db` and confirm whether the bad ordering/tool loss lives in the persisted session snapshot, the JSON-RPC journal, or the desktop renderer.
- [x] Patch the JSON-RPC live/journal projector path so raw Gemini search tool activity becomes `toolCall` items and aggregate final reasoning does not land after assistant output.
- [x] Patch the desktop shared-socket reducer so JSON-RPC `toolCall` notifications map back into the existing model-stream tool lifecycle with correct Gemini search arguments/results.
- [x] Add focused regressions for the live projector, journal replay, thread/read projection, and desktop JSON-RPC feed path, then rerun targeted verification plus `bun run typecheck`.

## Fix JSON-RPC Gemini Reasoning and Tool Projection Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now replay raw Gemini interaction events through the shared model-stream replay runtime, emit `toolCall` items for native Google web search, and suppress aggregate final reasoning when it only repeats streamed reasoning steps.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now treats JSON-RPC `item/started` tool notifications as metadata-only stream starts and synthesizes a proper `tool_call` from `item.args` before terminal result/error states, so Gemini native web search cards keep the correct input instead of polluted `{ id, toolName }` args.
- `test/jsonrpc.projectors.test.ts`, `test/jsonrpc.thread-read-projector.test.ts`, and `apps/desktop/test/protocol-v2-events.test.ts` now cover raw Gemini search projection, journal preservation of projected tool items, and the desktop JSON-RPC mapping for native web search plus late completed-only reasoning.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts test/jsonrpc.thread-read-projector.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Fix Steer Replay Reasoning Ordering

- [x] Reproduce the persisted normalized streamed-turn shape from `~/.cowork/sessions.db` and confirm the bad ordering only happened because the late-reasoning replay guard was raw-backed only.
- [x] Update both the desktop transcript feed mapper and the server snapshot projector to dedupe aggregate final reasoning across streamed steps and anchor any remaining late final reasoning before the streamed assistant item.
- [x] Add focused regression coverage for the normalized streamed-turn case and rerun the affected desktop/server verification plus typecheck.

## Fix Steer Replay Reasoning Ordering Review

- `apps/desktop/src/app/store.feedMapping.ts` now keeps ordered streamed-reasoning history for the current turn, suppresses final reasoning that is just the aggregate of earlier streamed steps, and anchors any remaining late final reasoning before the streamed assistant item even on normalized-only turns.
- `src/server/session/SessionSnapshotProjector.ts` mirrors the same reasoning-history, aggregate-dedup, and late-reasoning anchoring rules so persisted snapshots match the live desktop feed.
- `apps/desktop/test/store-feed-mapping.test.ts` and `test/sessionSnapshotProjector.test.ts` now cover the exact multi-step normalized-turn shape that produced the duplicate reasoning-after-answer artifact in the SQLite session.
- Verification passed with `bun test apps/desktop/test/store-feed-mapping.test.ts`, `bun test test/sessionSnapshotProjector.test.ts`, `bun test apps/desktop/test/protocol-v2-events.test.ts`, and `bun run typecheck`.

## Stream Reasoning Before First Tool Call

- [x] Confirm the missing live reasoning was caused by JSON-RPC projector buffering rather than the desktop chat renderer.
- [x] Add a dedicated JSON-RPC `item/reasoning/delta` notification and stream reasoning start/delta/completed through the live and journal projectors.
- [x] Update JSON-RPC journal read/replay handling so reasoning deltas can rebuild reasoning items before completion.
- [x] Route desktop shared-socket reasoning notifications through the existing model-stream pipeline, with final completed-text reconciliation.
- [x] Regenerate the JSON-RPC schema artifacts and add regression coverage for the live server, journal replay, thread/read projection, and desktop feed mapping paths.

## Stream Reasoning Before First Tool Call Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now emit `item/started`, `item/reasoning/delta`, and `item/completed` for streamed reasoning with a stable reasoning item id, instead of collapsing the whole summary into one late completed item.
- `src/server/jsonrpc/threadReadProjector.ts` now rebuilds reasoning text from journal delta events, and the JSON-RPC schema/docs advertise the new notification method.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now converts JSON-RPC reasoning notifications into synthetic `model_stream_chunk` events so the desktop reuses the same incremental reasoning feed path as native model streaming, while still reconciling against the completed reasoning text.
- Verification passed with `bun test test/jsonrpc.projectors.test.ts test/jsonrpc.thread-read-projector.test.ts test/server.jsonrpc.flow.test.ts`, `bun test --cwd apps/desktop test/protocol-v2-events.test.ts test/chat-reasoning-ui.test.ts`, and `bun run typecheck`.

## Skill Update Missing-Name Regression

- [x] Confirm the current update path falls back to an unrelated valid candidate when the original skill name is absent.
- [x] Change update resolution so updates fail explicitly when the original installation name is missing from the source.
- [x] Align update preflight checks with the new failure mode so the UI does not advertise an invalid update.
- [x] Add regression tests for the missing-name update path.
- [x] Run focused verification for skill update operations.

## Review

- `src/skills/operations.ts` now requires a valid same-name candidate for updates and returns a clear reason when the recorded installation name is missing or invalid in the source.
- `test/skills.operations.test.ts` covers both the preflight update check and the rejected mutation path for missing original names.
- Verification passed with `bun test test/skills.operations.test.ts` and `bun run typecheck`.

## CI Fix: Skill Detail Dialog Ubuntu Flake

- [x] Inspect the failing GitHub Actions `Docs + Tests` job and confirm the only actionable failure is `skill detail dialog > reveals the installation folder for non-workspace skills`.
- [x] Compare the CI environment with the local workspace and confirm the mismatch is `ubuntu-latest` in GitHub Actions versus local macOS arm64.
- [x] Reproduce the focused test and desktop test suite locally to confirm the branch logic is already correct and the failure is test-environment sensitive.
- [x] Harden `apps/desktop/test/skill-detail-dialog.test.ts` so it only exercises the open-folder wiring and does not depend on unrelated desktop/runtime UI modules in the full suite.
- [x] Remove the unnecessary `SkillDetailDialog` module mock from `apps/desktop/test/skills-catalog-page.test.ts` so Ubuntu cannot inherit a null dialog implementation across test files.
- [x] Run CI-shaped verification for the fix and record the results.

## CI Fix Review

- `apps/desktop/test/skill-detail-dialog.test.ts` now keeps the installation selected but sets `selectedSkillContent` to `null`, so the test still validates the `Open folder` click path without invoking markdown rendering or other UI surfaces that are irrelevant to the assertion.
- `apps/desktop/test/skills-catalog-page.test.ts` no longer mocks `SkillDetailDialog`, because the dialog is already closed in those page tests and the file-level mock can leak into the adjacent dialog test on Bun/Linux.
- Focused stress verification passed with `bun test apps/desktop/test/skill-detail-dialog.test.ts --rerun-each 25`.
- Regression guard verification passed with `bun test apps/desktop/test/skill-detail-dialog.test.ts apps/desktop/test/message-links.test.ts apps/desktop/test/updates-page.test.ts`.
- CI-shaped verification passed with `RUN_REMOTE_MCP_TESTS=1 bun test` showing `2763 pass`, `1 skip`, `0 fail`.

## Desktop App Platform-Specific Isolation

- [x] Audit all Electron desktop platform branches across window chrome, updater, menus/dialogs, server startup, and renderer chrome styling.
- [x] Extract platform-specific window and server lifecycle behavior behind explicit helpers/modules so macOS, Windows, and Linux tweaks stay isolated.
- [x] Keep the desktop app’s overall design and behavior intact while making Linux/native-frame behavior intentional instead of implicit.
- [x] Add or update focused desktop tests that lock down platform-specific behavior for each extracted branch.
- [x] Run focused desktop verification plus desktop typecheck/manual validation and capture the results.

## Desktop App Platform-Specific Isolation Review

- `apps/desktop/electron/services/windowChrome/` now owns per-platform BrowserWindow options, post-create tweaks, and runtime chrome syncing so macOS and Windows no longer share those branches in one file.
- `apps/desktop/electron/services/serverPlatform.ts` and `apps/desktop/electron/services/updaterPlatform.ts` isolate Windows-only Bun startup workarounds and macOS-only updater defaults away from the shared service implementations.
- `apps/desktop/electron/services/dialogs.ts` and `apps/desktop/electron/services/menuTemplate.ts` now route through explicit platform-specific builders instead of ad hoc conditional blocks.
- Focused verification passed with `bun test apps/desktop/test/dialogs.test.ts apps/desktop/test/menu.test.ts apps/desktop/test/server-manager.test.ts apps/desktop/test/updater-service.test.ts apps/desktop/test/window-enhancements.test.ts` and `bun run typecheck`.
- Manual Linux smoke validation passed with the running `bun run desktop:dev` session, confirming the desktop window keeps its native frame/menu integration and that the File menu remains interactive.

## Fix Broken Linux UI

- [x] Reproduce the blank Linux desktop UI and collect renderer/main-process evidence.
- [x] Identify the root cause of the Linux renderer failure without regressing macOS/Windows behavior.
- [x] Implement the minimal fix and add/update focused regression coverage.
- [x] Re-run focused desktop verification plus a Linux manual smoke walkthrough with artifacts.

## Fix Broken Linux UI Review

- The blank Linux renderer was caused by dev-only React Grab initialization in Electron on Linux, not by the earlier platform-chrome refactor.
- `apps/desktop/src/lib/reactGrabDevTools.ts` now skips React Grab only for Linux Electron development while leaving other development environments unchanged.
- `apps/desktop/test/react-grab-dev-tools.test.ts` covers the new Linux Electron skip path and the helper predicate directly.
- Verification passed with `bun test apps/desktop/test/react-grab-dev-tools.test.ts`, `bun run typecheck`, and a manual Linux Electron smoke run showing the populated desktop UI plus a responsive composer.

## Fix Live OpenAI Reasoning Handshake

- [x] Suppress commentary-only assistant `text_delta` chunks in the JSON-RPC live projectors.
- [x] Emit completed reasoning items from `reasoning_start` / `reasoning_delta` / `reasoning_end` live chunks so desktop thought bubbles match replay.
- [x] Prevent delayed `thread/read` hydration from overwriting fresher live feed items or the optimistic first user bubble.
- [x] Refresh `controlSocket.ts` lifecycle callbacks to dereference the latest store helpers.
- [x] Add focused regressions and run the desktop JSON-RPC verification slice plus `bun run typecheck`.

## Fix Live OpenAI Reasoning Handshake Review

- `src/server/jsonrpc/legacyEventProjector.ts` and `src/server/jsonrpc/journalProjector.ts` now drop commentary-phase `text_delta` chunks from the live assistant-message path, accumulate `reasoning_*` stream parts into one completed reasoning item, and suppress duplicate legacy reasoning finals when they match the just-emitted streamed summary.
- `apps/desktop/src/app/store.helpers/threadEventReducer.ts` now preserves the current live feed when a delayed `thread/read` snapshot would erase the optimistic first user bubble or when an actively running thread receives a snapshot that is behind the live event sequence; metadata still updates without letting counts/sequences move backward.
- `apps/desktop/src/app/store.helpers/controlSocket.ts` now re-reads the latest store getter and setter inside JSON-RPC lifecycle callbacks, so reconnect bootstrap uses the current workspace state instead of the first captured store instance.
- Focused projector coverage passed with `bun test test/jsonrpc.projectors.test.ts`.
- Desktop JSON-RPC parity and reconnect coverage passed with `bun test --cwd apps/desktop test/store-feed-mapping.test.ts test/protocol-v2-events.test.ts test/chat-reasoning-ui.test.ts test/control-socket.test.ts test/jsonrpc-single-connection.test.ts test/thread-reconnect.test.ts`.
- Typecheck passed with `bun run typecheck`.

## PR Comment Cleanup

- [x] Fix the unresolved workspace-defaults persistence review thread in `apps/desktop/src/app/store.actions/workspaceDefaults.ts`.
- [x] Re-verify the workspace-defaults desktop tests and typecheck after the review fix.
- [x] Resolve the actionable PR thread and close the stale unused-exports thread with evidence instead of code churn.

## PR Comment Cleanup Review

- `apps/desktop/src/app/store.actions/workspaceDefaults.ts` now narrows `buildApplySessionDefaultsMessage()` to the exact `apply_session_defaults` client message shape and removes the redundant runtime discriminator before `requestJsonRpcControlEvent()`, so the control path cannot silently skip persistence if that builder evolves later.
- Verification passed with `bun test --cwd apps/desktop test/workspace-settings-sync.test.ts` and `bun run typecheck`.
- Resolved PR thread `PRRT_kwDORLLhvs518ZN3` with the fix in commit `420c3969`, and closed stale thread `PRRT_kwDORLLhvs518ZN4` after revalidating the current `threadEventReducer.ts` call sites via `rg`.

## Reconnect Review Fixes

- [x] Preserve queued retryable JSON-RPC requests across transient reconnect handshake failures without regressing reconnect exhaustion handling.
- [x] Apply JSON-RPC notification opt-out filters to replayed journal events during `thread/resume`.
- [x] Re-run targeted reconnect/runtime verification and typecheck, then resolve the matching PR threads.

## Reconnect Review Fixes Review

- `src/client/jsonRpcSocket.ts` now keeps retryable queued operations intact across transient `initialize` handshake failures while the socket is still auto-reconnecting, but still rejects them once reconnect attempts are exhausted or the socket is intentionally closed.
- `src/server/startServer.ts` now applies `shouldSendJsonRpcNotification()` during journal replay, so `thread/resume` respects the same notification opt-out contract as live streaming.
- Verification passed with `bun test test/jsonrpcSocket.runtime.test.ts test/server.jsonrpc.flow.test.ts` and `bun run typecheck`.

## Provider Refresh Review Fixes

- [x] Fix the remaining provider refresh generation race in the desktop control socket without widening the protocol surface.
- [x] Add regressions for older `provider_status` events and bootstrap completion racing with a newer manual refresh.
- [x] Re-run the focused desktop provider/control tests plus `bun run typecheck`, then resolve the remaining PR threads.

## Provider Refresh Review Fixes Review

- `apps/desktop/src/app/store.helpers/controlSocket.ts` now puts bootstrap refreshes on the same `providerStatusRefreshGeneration` contract as manual and auth-triggered refreshes, and it no longer lets `provider_status` or generic control error events clear `providerStatusRefreshing` outside that generation-aware completion path.
- `apps/desktop/test/control-socket.test.ts` now covers both races: an older `provider_status` event arriving while a newer manual refresh is still running, and bootstrap completion arriving after a newer manual refresh has already taken ownership of the spinner.
- Verification passed with `bun test --cwd apps/desktop test/control-socket.test.ts test/provider-actions.test.ts` and `bun run typecheck`.

## Turn Request Review Fixes

- [x] Make JSON-RPC `turn/start` wait for real session acceptance or rejection before replying.
- [x] Make JSON-RPC `turn/steer` wait for `steer_accepted` or a session error before replying.
- [x] Add server-flow regressions for accepted `turn/start`, busy `turn/start`, accepted `turn/steer`, and rejected `turn/steer`, then rerun the affected desktop/server slices plus `bun run typecheck`.

## Turn Request Review Fixes Review

- `src/server/startServer.ts` now routes JSON-RPC `turn/start` and `turn/steer` through the existing session-event capture helper so request responses reflect the first real session outcome instead of fire-and-forget guesses. `turn/start` only returns success after `session_busy: true` yields a concrete `turnId`, and `turn/steer` only returns success after `steer_accepted`; session-level rejections now become JSON-RPC errors.
- `test/server.jsonrpc.flow.test.ts` now asserts that accepted `turn/start` responses already carry the concrete `turn.id` with `inProgress` status, and it adds request-level regressions for busy `turn/start`, accepted `turn/steer`, and stale-turn `turn/steer`.
- Verification passed with `bun test test/server.jsonrpc.flow.test.ts`, `bun test --cwd apps/desktop test/jsonrpc-single-connection.test.ts`, and `bun run typecheck`.

## Socket Close Review Fix

- [x] Guard shared JSON-RPC socket lifecycle callbacks so stale sockets cannot clear active workspace control state after a server URL swap.
- [x] Add a regression for a deferred old-socket close arriving after the replacement socket has already opened.
- [x] Re-run the focused desktop socket lifecycle tests plus `bun run typecheck`, then resolve the remaining PR thread.

## Socket Close Review Fix Review

- `apps/desktop/src/app/store.helpers/jsonRpcSocket.ts` now checks that a lifecycle callback belongs to the current `RUNTIME.jsonRpcSockets` entry before syncing workspace open/close state, so a stale socket cannot null out `controlSessionId` or trigger workspace control cleanup after a replacement socket has already taken over.
- `apps/desktop/test/control-socket.test.ts` now simulates a deferred close on the old socket after a `serverUrl` change and asserts that the active replacement socket keeps its control session state.
- Verification passed with `bun test --cwd apps/desktop test/control-socket.test.ts test/thread-reconnect.test.ts` and `bun run typecheck`.

## Final PR Review Sweep

- [x] Revalidate the remaining unresolved JSON-RPC server subprotocol thread on current `HEAD` before changing transport code.
- [x] Re-run the focused server JSON-RPC transport tests, desktop shared-socket tests, and `bun run typecheck` before resolving the last review threads.

## Final PR Review Sweep Review

- `src/server/startServer.ts` already returns the negotiated `Sec-WebSocket-Protocol` value from the WebSocket upgrade path, and current `HEAD` preserves that on the wire for both browser-style and multi-offer `ws` clients.
- Revalidated transport coverage passed with `bun test test/server.jsonrpc.test.ts` and `bun test test/server.jsonrpc.flow.test.ts`.
- Revalidated desktop/socket coverage passed with `bun test --cwd apps/desktop test/control-socket.test.ts test/thread-reconnect.test.ts`.
- Typecheck passed with `bun run typecheck`.

## Harden Workspace JSON-RPC Socket Replacement

- [x] Add monotonic per-workspace JSON-RPC socket generation bookkeeping in desktop runtime state.
- [x] Gate shared workspace socket lifecycle and JSON-RPC routing callbacks on the active workspace generation instead of socket map entry identity.
- [x] Bump socket generation before retiring a workspace control socket for URL swaps and other explicit workspace-socket retirement paths.
- [x] Extend desktop regressions for stale retired-socket close, stale thread disconnect, and stale notification/request routing.
- [x] Run the requested focused desktop verification slice and capture the result.

## Harden Workspace JSON-RPC Socket Replacement Review

- `apps/desktop/src/app/store.helpers/runtimeState.ts` now tracks a monotonic active JSON-RPC socket generation per workspace, alongside helpers that mirror the repo’s existing generation-based stale-result guards.
- `apps/desktop/src/app/store.helpers/jsonRpcSocket.ts` now stamps each shared workspace socket with its generation, gates `onOpen`, `onClose`, `onNotification`, and `onServerRequest` on the active generation, and bumps generation before retiring a URL-swapped socket instead of depending on `RUNTIME.jsonRpcSockets.get(workspaceId) === socket`.
- `apps/desktop/src/app/store.actions/workspace.ts` now also bumps socket generation before restart/remove retirement so a late close from the old active socket cannot disconnect threads or clear control state after explicit workspace socket teardown.
- `apps/desktop/test/control-socket.test.ts`, `apps/desktop/test/thread-reconnect.test.ts`, and `apps/desktop/test/protocol-v2-events.test.ts` now lock down stale retired-socket close, stale disconnect, and stale notification/server-request routing behavior while confirming the replacement socket still handles live events normally.
- Verification passed with `bun test apps/desktop/test/control-socket.test.ts apps/desktop/test/thread-reconnect.test.ts apps/desktop/test/protocol-v2-events.test.ts`.

## JSON-RPC Review Thread Fixes

- [x] Correlate MCP validation and MCP auth responses by server name in both the extracted JSON-RPC route handlers and the legacy `startServer.ts` switch.
- [x] Correlate `cowork/skills/read` results by requested skill name and stop skill enable/disable/delete from reporting success after a rejected mutation.
- [x] Return emitted provider, skill-installation, memory, and workspace-backup error events as JSON-RPC errors instead of waiting for the 5-second capture timeout.
- [x] Add focused extracted-route and live-server regressions for the review-thread cases, then rerun the affected tests plus `bun run typecheck`.

## JSON-RPC Review Thread Fixes Review

- `src/server/jsonrpc/routes/providerAndMcp.ts`, `src/server/jsonrpc/routes/skillsMemoryAndWorkspaceBackup.ts`, and `src/server/startServer.ts` now correlate MCP validation/auth and skill-read captures to the requested server or skill, so concurrent control calls cannot cross-resolve on the first matching event.
- The same handlers now treat emitted `error` events as terminal JSON-RPC outcomes across provider auth, skill mutations, skill-installation update checks, memory controls, and workspace backup controls, instead of waiting for a timeout when the session already reported a concrete failure.
- `test/jsonrpc.routes.review-fixes.test.ts` adds extracted-route regressions for the review fixes, including realistic provider- and backup-sourced error events plus installation-check failures, and `test/server.jsonrpc.control.test.ts` covers the live server behavior for provider auth, skill mutation failures, installation-check failures, memory failures, and workspace backup failures.
- Verification passed with `bun test test/jsonrpc.routes.review-fixes.test.ts`, `bun test test/server.jsonrpc.control.test.ts`, and `bun run typecheck`.

## Full Test Lane Cleanup

- [x] Reproduce the 7 `bun run test` failures in focused server and desktop slices before changing code.
- [x] Port the extracted JSON-RPC pending-prompt replay logic into the live `startServer.ts` thread resume/read path and remove the journal-write bottleneck that kept the >1000-event read test over the timeout budget.
- [x] Restore chronological mixed reasoning/tool activity grouping in the desktop chat summary helpers without regressing adjacent tool merge behavior.
- [x] Re-run the focused failing slices, `bun run typecheck`, and the full `bun run test` lane.

## Full Test Lane Cleanup Review

- `src/server/startServer.ts` now replays pending ask/approval prompts on `thread/resume`, dedupes them against journal replay and disconnected-buffer replay, batches thread-journal SQLite writes with `appendThreadJournalEvents()`, and compacts consecutive assistant snapshot fragments in `thread/read` responses so the heavy reconnect/read flow no longer times out on large journals.
- `src/server/session/AgentSession.ts`, `src/server/session/SessionSnapshotProjector.ts`, and `src/server/jsonrpc/routes/shared.ts` now expose a non-cloning live snapshot read path for JSON-RPC/session summary callers, avoiding redundant deep copies of large live snapshots during server reads.
- `apps/desktop/src/ui/chat/activityGroups.ts` now preserves feed chronology when mixing reasoning and tool entries, while still deduping adjacent identical reasoning notes and merging only truly adjacent compatible tool lifecycle rows.
- Verification passed with `bun test test/server.jsonrpc.flow.test.ts --test-name-pattern "thread/resume replays a pending user input request after reconnect|thread/resume replays a pending approval request after reconnect|thread/read and thread/resume replay journals beyond 1000 events"`, `bun test apps/desktop/test/chat-activity-group-card.test.tsx apps/desktop/test/chat-activity-groups.test.ts`, `bun run typecheck`, and `bun run test`.

## Final Comment Cleanup

- [x] Apply JSON-RPC response-envelope thread state to `applyWorkspaceDefaultsToThread` without routing thread results through the workspace control reducer.
- [x] Return emitted skill-installation read and mutation errors immediately in both the legacy JSON-RPC switch and the extracted route handlers.
- [x] Add focused desktop and server regressions, then re-run typecheck and the full Bun test lane before resolving the remaining review threads.

## Final Comment Cleanup Review

- `apps/desktop/src/app/store.actions/workspaceDefaults.ts` now normalizes JSON-RPC `event`/`events` payloads for thread-scoped defaults application and applies thread runtime `config`, `sessionConfig`, and `enableMcp` state directly from the response envelope, while still preserving the old generic transport-failure notification for socket/request errors.
- `src/server/startServer.ts` and `src/server/jsonrpc/routes/skillsMemoryAndWorkspaceBackup.ts` now treat emitted validation errors from `cowork/skills/installation/read` and `cowork/skills/installation/{enable,disable,delete,update}` as terminal JSON-RPC errors instead of waiting for the capture timeout.
- `apps/desktop/test/workspace-settings-sync.test.ts`, `test/jsonrpc.routes.review-fixes.test.ts`, and `test/server.jsonrpc.control.test.ts` now lock down the thread-response envelope state path plus the skill-installation error returns in both extracted-route and live-server coverage.
- Verification passed with `bun test apps/desktop/test/workspace-settings-sync.test.ts`, `bun test test/jsonrpc.routes.review-fixes.test.ts`, `bun test test/server.jsonrpc.control.test.ts`, `bun run typecheck`, and `bun run test`.
