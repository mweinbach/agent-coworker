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
