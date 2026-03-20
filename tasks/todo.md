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
- [x] Run CI-shaped verification for the fix and record the results.

## CI Fix Review

- `apps/desktop/test/skill-detail-dialog.test.ts` now keeps the installation selected but sets `selectedSkillContent` to `null`, so the test still validates the `Open folder` click path without invoking markdown rendering or other UI surfaces that are irrelevant to the assertion.
- Focused stress verification passed with `bun test apps/desktop/test/skill-detail-dialog.test.ts --rerun-each 25`.
- Regression guard verification passed with `bun test apps/desktop/test/skill-detail-dialog.test.ts apps/desktop/test/message-links.test.ts apps/desktop/test/updates-page.test.ts`.
- CI-shaped verification passed with `RUN_REMOTE_MCP_TESTS=1 bun test` showing `2763 pass`, `1 skip`, `0 fail`.
