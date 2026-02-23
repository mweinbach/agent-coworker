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
