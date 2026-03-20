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
