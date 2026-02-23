# Task: Handle invalid cowork Codex auth before returning from read

## Plan
- [x] Update `readCodexAuthMaterial` to treat malformed cowork auth JSON/schema as recoverable and continue fallback logic.
- [x] Preserve existing behavior for valid cowork auth and non-recoverable filesystem errors.
- [x] Add regression tests for malformed cowork JSON and legacy migration fallback behavior.
- [x] Run tests (`bun test test/providers/codex-auth.test.ts` and `bun test`).

## Review
- `readCodexAuthMaterial` now catches invalid cowork JSON parse errors and treats that file as missing instead of throwing.
- When cowork auth JSON exists but fails current schema validation, it now attempts legacy parsing and then continues to legacy-file migration fallback.
- Added regression tests for:
  - invalid cowork JSON returning `null` when migration is disabled
  - schema-invalid cowork JSON still allowing legacy `.codex/auth.json` migration
- Verification:
  - `bun test test/providers/codex-auth.test.ts`
  - `bun test`
