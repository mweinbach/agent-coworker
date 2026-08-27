# Complexity and cleanup tracker

Scope: every tracked path at `e0e682ee`, including the harness, server, desktop,
mobile, native code, tests, build/release tooling, configuration, documentation,
prompts, and bundled skills. Ignored dependencies, build output, and local auth or
session state are not source and are not part of this audit.

## Method

Use `bun run complexity` for the current inventory and largest hotspots, or
`bun run complexity --json` for the complete machine-readable report. The command
uses the installed Biome cognitive-complexity rule with its default threshold of
15; it does not invent a second complexity algorithm or add a dependency.
Inventory counts include all tracked paths. Cognitive scores cover only the
JavaScript/TypeScript files enabled by `biome.json`; Rust, Swift, Kotlin, shell,
Python, documentation, generated artifacts, and vendored code need separate
inspection. A high score identifies a review target, not a defect.

`bun run knip` is a separate consumer-graph check. This sweep added mobile routes,
Electron's quality entrypoint, and TSX tests to its configuration. A reported
export is still not proof that it can be deleted: public type surfaces, deliberate
test seams, and dynamic consumers need inspection across the whole repository.

## Baseline

| Measurement | Before | After |
| --- | ---: | ---: |
| Tracked paths | 2,656 | 2,660 |
| Tracked text lines (includes tests/docs/generated/vendor content) | 673,216 | 672,647 |
| Files scanned by the cognitive-complexity command | 1,876 | 1,879 |
| Functions with cognitive complexity above 15 | 713 | 709 |
| Source functions above 15 | 661 | 657 |
| Test/quality-harness functions above 15 | 52 | 52 |
| Knip unused-file candidates, corrected scan scope | 3 | 0 |
| Knip unused-export candidates, corrected scan scope | 255 | 242 |
| Knip unused-type candidates, corrected scan scope | 146 | 147 |

The original narrower Knip configuration reported 3 files, 214 exports, and 100
types. The table instead uses the corrected configuration against the untouched
baseline checkout, so the comparison does not mistake wider coverage for new
dead code.

Product code is 1,486 lines smaller (189 added, 1,675 removed across 55 files);
the total repository reduction is smaller because the sweep adds regression
coverage and the tracker. The largest reported function in `src/agent.ts` fell
from 83 to 34 after removing the test-only adapter and its nested wrapper. The
report command itself is included in the measurements, with a score of 16.

The initial full suite failed in five files: three used synthetic `/home` paths
that hit the macOS automounter; two React Native tests lacked initial mock exports.
Permission checks correctly failed closed when the filesystem returned `EINTR`.
The fixture repair does not change production permissions or increase timeouts.
Baseline typecheck, lint, formatting, and protocol/doc checks passed. Biome's
stale schema-version reference was migrated to the installed version.

## Cleanup plan

Apply the ai-slop-cleaner workflow: lock behavior before edits, change one smell
at a time, and run the full repository CI lane before each logical commit.

- [x] Add a small, tested report command and record coverage and exclusions.
- [x] Dead code: remove proven unused client components/helpers, obsolete mobile
  query scaffolding, constant-true skill gates, and disconnected harness helpers.
- [x] Duplication: use the existing task-lock error contract and remove
  pass-through wrappers; derive artifact types from existing schemas while
  preserving all 28 exported shapes and generated protocol bytes.
- [x] Error handling: reproduce checkpoint ID reuse after deletion and message
  ordering at reasoning boundaries, then fix the demonstrated causes.
- [x] Tests: move tests off obsolete duplicates onto live runtime boundaries;
  retain denial, recovery, ordering, and persisted-contract coverage.
- [x] Replace stale audit advice with a link to current evidence; keep security,
  auth, persistence, and platform safeguards intact.
- [x] Run final tests, typechecks, lint/format, docs, dead-code analysis, and
  applicable mobile/native checks; record remaining risks without hiding them.

## Coverage and findings

Every area received an inventory and structural scan; deep reads focused on
reported smells, consumers, tests, and large functions. This is not a claim that
every line or image was manually reviewed.

| Baseline area | Files | Text lines | Review |
| --- | ---: | ---: | --- |
| Harness outside server | 368 | 87,712 | Providers, runtime, tools, platform, auth/config, plugins, skills, imports, CLI, telemetry |
| Server | 216 | 63,921 | JSON-RPC, projection, sessions, tasks, storage, backups, H3, threads, artifacts |
| Desktop | 731 | 207,247 | Renderer/store, Electron/IPC, tests, quality gates, packaging; images inventoried |
| Mobile | 259 | 37,153 | Expo routes/stores, relay, native module, platform projects, tests, bundled skill docs |
| Root tests | 489 | 181,924 | Full runner plus targeted behavior locks; obsolete tests removed only with their dead path |
| Build scripts and harness tooling | 18 | 5,778 | Entrypoints, dependency/release contracts, raw-loop validation and docs checker |
| Windows crate and vendored PTY code | 29 | 13,064 | Native source/contract inspection and Rust formatting; real Windows enforcement requires Windows CI |
| Configuration | 112 | 1,269 | JSON/model registry inventory and existing schema/registry tests |
| Documentation and agent docs | 42 | 10,788 | Current architecture/protocol contracts; retired misleading bloat advice |
| Prompts, bundled skills, example, workflow | 33 | 9,304 | Runtime entrypoints/guidance and existing prompt/workflow tests |
| Tool/agent metadata, bundled external skills, CI, root files | 359 | 55,056 | Configuration/entrypoint inspection; external skill content retained, not rewritten as product code |

Large dispatchers, protocol schemas, authorization checks, persistence migrations,
and vendor code are not deletion candidates solely because of size. Do not move
branches into new single-use wrappers just to lower a metric.

## Finding ledger

| Finding | Status | Behavior lock / action |
| --- | --- | --- |
| Unused desktop components, markdown/time modules, compatibility aliases | Implemented | Existing selector, sidebar, Canvas formatting/persistence, attachment, diagnostics, and window tests passed before/after |
| Unused mobile query hooks/provider/dependency | Implemented | Rendered real provider bootstrap/foreground/disposal tests; minimal lockfile deletion; iOS/Android exports pass |
| Disconnected model discovery, skill gate, CLI map, download/lock wrappers | Implemented | Existing provider, skill/reference, CLI/import, grep and lock suites passed before/after |
| Test-only telemetry redactor clone | Implemented | Replaced clone test with emitted production span assertions for secrets, arrays, cycles, and input immutability |
| Synthetic host paths and incomplete React Native mocks | Implemented | Temporary filesystem fixtures; required initial mock exports; no permission or timeout changes |
| Ambiguous native startup status locator | Implemented | Real Electron light/dark/system startup checks pass with the workspace status selected explicitly |
| Checkpoint ID collision after deleting a middle checkpoint | Implemented | Unique IDs and preserved restores in archive and directory-fallback modes, including reopening |
| Buffered text emitted after a reasoning/turn completion boundary | Implemented | Exact notification order and replay with no duplicate assistant text |
| Workflow concurrency-only updates silently discarded | Implemented | Direct settings and inherited defaults update; repeated effective value remains a no-op |
| Synchronous action failures leave capture sinks/timers behind | Implemented | Throw/reject, timeout, match, and no-op cleanup for all capture variants |
| Legacy snapshot import omits agent profile | Implemented | Profile survives database record, summary, snapshot import/reopen, and interrupted migration retry |
| Skill refresh failure becomes an unhandled rejection and consumes revision | Implemented | Failed refresh is observed; same revision can retry and queued newer work continues |
| Ripgrep download attempts leak temporary directories | Implemented | Success, 404 fallback, checksum/download/extraction failures clean their attempt directory; cleanup errors warn without masking the original result |
| Repeated workspace hashing, task-lock/attachment helpers and artifact types | Implemented | Preserve persisted IDs, error shape, display text, all 28 exported types, and schema-generated protocol bytes |
| Unreachable web-search normalization, duplicated atomic retries, placeholder plugin data | Implemented | Raw/malformed provider response cases, delegated retry budgets/backoff, and existing plugin override tests |
| Duplicated preload parsing, notification caps, Canvas classes, and unused wrappers | Implemented | Rendered Canvas matrix, real preload IPC validation, notification limits, and consumer checks |
| Legacy agent adapter used only by tests | Implemented | Tests use live runtime injection; PI tool-loop tests execute tools and inspect history, errors, aborts, step limits, and callback completion |
| Quality entrypoint reported as production complexity | Implemented | Explicit fixture classification; regression includes normalized Windows paths |
| Hidden New Chat button remains keyboard-focusable | Implemented | Inert hidden control; rendered hidden/revealed regression and all three real Electron axe failures now pass |
| Detached transcript journey expects obsolete unread-label wording | Implemented | Match existing updates label; count, visibility, anchor, and performance assertions are unchanged |
| Async callback test could pass without actual backpressure | Implemented | Independent dropped-promise probe exposed the gap; assertion now waits an event-loop turn while the callback remains blocked |

## Verification and remaining limits

- `bun run test` passes all 707 test files, following the earlier 701-file cleanup
  pass. Reproduced production defects have failing-before/passing-after
  regressions; behavior-preserving deletions passed their locks before and after.
- `bun run typecheck`, `bun run lint`, `bun run check`, and `bun run docs:check`
  pass. The report script/tests also pass standalone strict typechecking. The
  platform-boundary baseline was refreshed only downward, including pre-existing
  reductions; no new platform exceptions were introduced.
- Mobile typechecking and fresh iOS/Android Metro exports pass. Ten real Electron
  journeys pass after rebuilding: chat/approval/steering, queued interactions,
  detached transcript restoration, quick chat/failures, Canvas/files/resizers,
  persisted settings, New Chat accessibility, and light/dark/system startup.
- All 28 artifact types remain mutually assignable to their prior definitions;
  generated JSON-RPC protocol output is byte-for-byte unchanged (1,076,304 bytes).
  Golden vectors preserve workspace IDs and storage keys across all six hash
  consumers, including UTF-16 inputs.
- Independent reviews covered the server, harness, clients, and tracker. An
  isolated CLI smoke check exercised Git enumeration, deleted/untracked files,
  binary detection, symlink non-traversal, output modes, invalid arguments, and
  reporter/command failures in addition to the committed report unit tests.
- All 154 strict JSON documents parse; the desktop TypeScript config is JSONC
  and is checked by TypeScript. The Python script compiles, the shell script
  passes `bash -n`, and `cargo fmt --all --check` passes.
- The local Electron run used the existing `recordVideo: false` option in a
  temporary config. The full Linux recording/screenshot matrix and real Windows
  sandbox enforcement were not run on this Mac. Mobile exports are bundle checks,
  not physical-device or native-project verification.
- Knip remains advisory and exits nonzero for the 242 export and 147 type
  candidates. The added type candidate is the deliberately preserved
  `AgentControlTaskLockError` compatibility alias. Consumer-graph candidates are
  not permission to delete public contracts or dynamic entrypoints.

## Remaining complexity targets

These are review targets for focused follow-up, not known defects or justification
for cosmetic helper extraction. Event routing and lifecycle behavior need stronger
local contracts before substantial decomposition.

| File | Largest cognitive score | Preserved responsibility |
| --- | ---: | --- |
| `src/runtime/googleNative/stream/processEvent.ts` | 247 | Native provider event mapping |
| `src/runtime/codexAppServer/notifications.ts` | 205 | App-server notifications and continuation state |
| `apps/desktop/src/ui/layout/AppTopBar.tsx` | 187 | Platform, thread, and navigation control states |
| `src/cli/repl/commandRouter.ts` | 162 | Distinct CLI command dispatch |
| `apps/desktop/src/app/store.helpers/controlSocket.ts` | 161 | Control-socket lifecycle and server state |

Other deferred candidates include the advanced-memory editor's write-only slug
draft (save-path coverage is insufficient), mobile protocol/adaptor exports, and
similar-looking record, citation, and skill-scope helpers with different contracts.
No reproduced production defect from this sweep remains queued.
