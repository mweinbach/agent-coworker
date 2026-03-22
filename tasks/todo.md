# Task Plan

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
