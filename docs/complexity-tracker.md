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

`bun run complexity:compare --base <git-ref>` compares the current checkout with
its merge base against that ref. The PR CI job checks out the actual PR head and
uses the PR base SHA. Both scans use the installed Biome binary; the temporary
base checkout disables Git hooks and is removed after success or failure.
The comparison maps line shifts and Git-detected renames, and uses columns to
distinguish functions on the same line. Changed declarations and unmatched moves
are conservatively flagged as new, including visibility-only changes.

CI publishes advisory annotations, a job summary, and a JSON artifact. Unchanged
or reduced existing scores are not flagged; incomplete scans and invalid source
fail the job. A justified dispatcher or lifecycle guard needs a specific reason
in the PR, not a cosmetic helper extraction. Scan scope still follows each
revision's Biome configuration, so configuration changes need review too.

`bun run knip` is a separate consumer-graph check. This sweep added mobile routes,
Electron's quality entrypoint, and TSX tests to its configuration. A reported
export is still not proof that it can be deleted: public type surfaces, deliberate
test seams, and dynamic consumers need inspection across the whole repository.
The [unused-code audit](unused-code-audit.md) records every remaining candidate's
disposition, including retained compatibility APIs and dynamic test consumers.

## Results

| Measurement | Original `e0e682ee` | First pass `b739dbdd` | Continued sweep `5ba8f6f8` | Completion `bcc432d3` | ai-slop-cleaner follow-up |
| --- | ---: | ---: | ---: | ---: | ---: |
| Tracked paths | 2,656 | 2,660 | 2,663 | 2,680 | 2,682 |
| Tracked text lines (includes tests/docs/generated/vendor content) | 673,216 | 672,647 | 673,463 | 676,806 | 677,546 |
| Files scanned by the cognitive-complexity command | 1,876 | 1,879 | 1,882 | 1,892 | 1,894 |
| Functions with cognitive complexity above 15 | 713 | 709 | 709 | 710 | 710 |
| Source functions above 15 | 661 | 657 | 657 | 657 | 657 |
| Test/quality-harness functions above 15 | 52 | 52 | 52 | 53 | 53 |
| Knip unused-file candidates, corrected scan scope | 3 | 0 | 0 | 0 | 0 |
| Knip unused-export candidates, corrected scan scope | 255 | 242 | 227 | 106 | 106 |
| Knip unused-type candidates, corrected scan scope | 146 | 147 | 133 | 130 | 130 |

The original narrower Knip configuration reported 3 files, 214 exports, and 100
types. The table instead uses the corrected configuration against the untouched
baseline checkout, so the comparison does not mistake wider coverage for new
dead code.

The first pass removed 1,486 net product lines (189 added, 1,675 removed across
55 files). The continuation removes another 269 (295 added, 564 removed across
6 files), for a cumulative reduction of 1,755 lines. Repository text now grows
because the continuation adds regression coverage. The largest reported function
in `src/agent.ts` fell
from 83 to 34 after removing the test-only adapter and its nested wrapper. The
report command itself is included in the measurements; its first-pass score was 16.

The initial full suite failed in five files: three used synthetic `/home` paths
that hit the macOS automounter; two React Native tests lacked initial mock exports.
Permission checks correctly failed closed when the filesystem returned `EINTR`.
The fixture repair does not change production permissions or increase timeouts.
Baseline typecheck, lint, formatting, and protocol/doc checks passed. Biome's
stale schema-version reference was migrated to the installed version.

## First-pass cleanup plan

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

## First-pass finding ledger

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

## First-pass verification and remaining limits

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
- The first-pass Knip scan exited nonzero for 242 export and 147 type
  candidates. Its added type candidate is the deliberately preserved
  `AgentControlTaskLockError` compatibility alias. Consumer-graph candidates are
  not permission to delete public contracts or dynamic entrypoints.

## Remaining complexity targets

These remain review targets, not known defects or justification for cosmetic
helper extraction. Scores include the ai-slop-cleaner follow-up below. The passes
add lifecycle contracts and remove duplication; further decomposition still needs
a focused behavior-preserving plan.

| File | Largest cognitive score | Preserved responsibility |
| --- | ---: | --- |
| `src/runtime/codexAppServer/notifications.ts` | 208 | App-server notifications and continuation state |
| `apps/desktop/src/ui/layout/AppTopBar.tsx` | 179 | Platform, thread, and navigation control states |
| `apps/desktop/src/app/store.helpers/controlSocket.ts` | 160 | Control-socket lifecycle and server state |
| `src/cli/repl/commandRouter.ts` | 150 | Distinct CLI command dispatch |
| `src/runtime/googleNative/stream/processEvent.ts` | 150 | Native provider event mapping |

Mobile shared-facade exports and similar-looking record, citation, and skill-scope
helpers retain distinct contracts; their classification is recorded in the unused
code audit. The memory editor draft and unused mobile protocol families were
resolved in the continuation. The completion ledger below records the later
lifecycle and native-platform findings.

## Continuation from `b739dbdd`

The next pass starts from the clean, verified first-pass head: 709 cognitive
hotspots, zero unused-file candidates, and 242 export / 147 type candidates.
Freshly fetched `origin/main` is already an ancestor of the working branch.

- [x] Dead code: lock the memory editor's real create/edit/save/retry paths before
  deleting its redundant draft slug. Remove the mobile protocol declarations
  left without consumers after the unused query layer was deleted; retain live
  thread/snapshot compatibility and workspace validators.
- [x] Duplication: unify repeated Google event constructors and updates while
  preserving start/reset versus delta/merge behavior and emitted event order.
- [x] Needless state and wrappers: use the Codex assistant text Map's existing
  insertion order, canonical phase parsing, and direct file-change payload merge.
- [x] UI duplication: share the toolbar's identical container, Busy status, and
  context controls without changing branch-specific control order or layout.
- [x] Reinforce tests, independently review the changes, run the full CI lane and
  relevant app verification, then record measured results and commit each slice.

| Finding | Result | Evidence |
| --- | --- | --- |
| Streamed Google native-tool arguments disappear from completed results | Fixed in live processing and replay | Eight failing-before/passing-after cases cover content/step events and search queries/URLs |
| Repeated native stream constructors and normalization | Removed duplication; cognitive score 247 to 150 | 36 behavior locks passed before cleanup; 40,000 deterministic comparisons match the bug-fixed original's state and emitted parts |
| Redundant Codex assistant ordering state, phase parser, payload wrapper | Removed; 17 fewer product lines | Ten new ordering, phase, stream, and merge-precedence locks passed before and after |
| Duplicated toolbar containers, status/context controls, offsets, and mount reset | Shared existing markup; cognitive score 187 to 179 | 15 rendered locks plus platform, overlay, Canvas lifecycle, and real Electron journeys |
| Unread memory draft slug duplicates the edit target | Deleted | Parent create/edit/failure/pending/retry/reset flows preserve target slug, folder, cwd, and trimmed payloads |
| Unused mobile protocol scaffolding left after query-layer deletion | Removed 14 schema/type families; kept the workspace validator private | Consumer search, focused client tests, mobile typecheck; all 12 live schema contracts are byte-identical |

Independent reviews found no introduced runtime, UI, authorization, or protocol
regressions. The Google callback/identity/metadata behavior was reviewed separately
from its numerical complexity improvement. No new dependencies or production
helper layers were added.

Continuation verification passes: `bun run test` reports 8,252 passing tests across
710 files, with 27 existing skips. Root/harness/desktop and mobile typechecking,
lint, formatting, and docs checks pass. Both mobile exports and the rebuilt
10-journey real Electron run pass. All 12 live mobile schema contracts remain
byte-identical; the server's generated JSON-RPC protocol is also unchanged.

The platform limitations described above still apply. Knip's 227 export and 133
type candidates remain advisory; its unused-file count stays at zero. Product
fixes, refactors, and the tracker update are committed as separate logical slices.

## Completion pass from `5ba8f6f8`

This pass covers the four agreed follow-ups: native platform verification,
desktop socket and Codex notification lifecycles, PR complexity comparison, and
classification of every remaining Knip candidate. Earlier results above are
historical checkpoints, not the final platform status.

- [x] Audit all 361 unused-export/type candidates, including the task enum
  exposed by deleting its unused test hook. Delete 12 declarations, make 113
  internal declarations private, and document why 236 contracts and dynamic
  test APIs remain. Do not suppress the retained findings.
- [x] Reproduce and repair stale desktop responses, replacement/disposal races,
  cold-start refresh ownership, and cancelled-caller bootstrap recovery.
- [x] Reproduce and repair Codex callback ordering, completion backpressure, and
  callback failures without losing abort, disconnect, or timeout behavior.
- [x] Add the tested PR comparison job, including safe temporary-checkout cleanup
  and disabled Git hooks. Keep complexity findings advisory.
- [x] Finish the Linux Electron matrix, reviewed visual baselines, and native
  Android journeys; record the iOS access limit separately.
- [x] Run the full local CI lane, refresh measurements, and commit verified slices.
  The pushed commit and GitHub job results are recorded in
  [PR #322](https://github.com/mweinbach/agent-coworker/pull/322).
- [ ] Complete native iOS simulator runtime verification. Worktree access is now
  available; the follow-up below records the scene-lifecycle launch failure.

| Finding | Result | Behavior lock / evidence |
| --- | --- | --- |
| Workspace responses survive socket replacement, disposal, or a newer refresh | Fixed | Deferred-response lifecycle tests, coalesced cold bootstrap, cancelled-caller recovery, and the real WebSocket integration test |
| Codex turn completion outruns asynchronous stream callbacks | Fixed | Ordered callback delivery, rejected callbacks, duplicate/foreign-turn filtering, tool-output interleavings, and abort/disconnect/deadline tests |
| An apparently unused Electron export is loaded through a cache-busted dynamic import | Retained | Full-suite failure reproduced; `MAX_READ_FILE_BYTES` restored and all visibility candidates checked for dynamic consumers |
| Comparison checkout can run a local Git hook or survive a failed partial checkout | Fixed | Real temporary-repository tests prove hooks do not execute and partially registered worktrees are removed |
| General CI tests lack the installed Expo SDK used by the new boundary tests | Fixed | A clean Linux run reproduces the missing module and passes after the locked install; parsed workflow tests guard mandatory installation before the suite and its cache inputs |
| Desktop gates expect obsolete drawer, composer, and startup behavior | Fixed | Tests assert the existing inline context layout and usable width, scoped recovery status, and editable disconnected composer; deliberate failures still fail |
| Electron quality code is excluded from normal TypeScript checking | Fixed | Quality harness included in the desktop project; incorrect Playwright types and browser callback shadowing corrected |
| Linux images predate the current compact layout and semantic typography | Refreshed after review | 33 baselines and the matching product image pass a clean 59-test Linux matrix; all four deliberate failure probes pass without relaxing tolerances or budgets |
| iOS lockfile still describes the older Expo/React Native native graph | Fixed dependency graph | Scoped CocoaPods resolution matches the already locked JavaScript dependencies; a repeated deployment-mode install succeeds |
| Releasing a glass button sends a null transform to React Native | Fixed | Rendered press/release and reduced-motion regressions; native Android scanner and manual pairing input no longer crash |
| Light-mode status icons lack contrast and Android instructions name an iPhone | Fixed | Rendered font-loading/light/dark states and both platform pairing states; native light/dark pairing screens inspected |
| Saved-desktop swipe rows crash without a gesture root | Fixed | Rendered router ancestry regression; native pairing, saved-desktop swipe actions, and background recovery pass |
| Android content starts underneath transparent navigation headers | Fixed | All four stack options checked on both platforms; Android screenshots confirm reserved header space while iOS options remain unchanged |
| Expo Link discards a row's dynamic style callback | Fixed | Installed Link/Slot regression fails before the fix; row geometry, press feedback, navigation, and accessibility labels pass on both platform branches |
| SF Symbol toolbar icons make Android actions disappear | Fixed | Installed Android renderer and iOS converters cover compose, menus, section order, and stop states; native glyphs render, and one Stop tap sends one interrupt, disables repeats, then restores the composer |
| Native settings switch thumbs ignore taps | Fixed | Native switch callback and parent-row regressions cover both starting values; emulator thumb and row taps each toggle once and the value survives a cold launch |

The completion snapshot contains 1,738 fewer product source lines than the
original: 858 additions and 2,596 deletions across 146 files under `src/`,
`apps/desktop/src/`, `apps/desktop/electron/`, and `apps/mobile/src/`. This is the
same source scope used for the earlier line comparisons. Repository text grows
because the sweep adds regression tests, audit records, and verification tooling;
native projects and assets are included in the inventory but not this source-line
subtotal. The extra hotspot relative to `5ba8f6f8` is in a regression test; the
source-hotspot count remains 657.

The completion measurements include code commit `0d1439bc` and this tracker
update. Final local verification passes: 8,355 tests across 718 files, with 27
existing skips; root, harness, desktop, and mobile TypeScript checks; standalone
strict checking of the comparison script/tests; Biome lint and formatting; docs
consistency; and fresh iOS/Android Hermes exports. All 45 mobile test files also
pass independently. One earlier full run overlapped the deliberately failing
asset regressions; the recorded final run starts after the corrected assets are
frozen and passes all six asset cases and eight native-toolbar cases.

A subsequent clean-CI check exposed a dependency setup gap in the new tests that
exercise the real Expo SDK: the general Tests job installed only root dependencies.
The job now installs the existing locked mobile dependency graph before running
the suite and shares the Mobile job's package-cache inputs. Fresh checkout
instructions document both installs; tests do not download dependencies or skip
the actual SDK coverage. Two parsed-workflow regressions fail before that change.
An independent Linux run installs the frozen graph and passes the real SDK tests
plus related mobile and workflow tests, with no product or lockfile changes.

The generated server JSON-RPC protocol remains byte-identical at 1,076,304 bytes,
and all 12 live mobile schema contracts remain unchanged. Knip reports no unused
files and retains exactly the documented 106 value exports and 130 types. Its
nonzero exit remains advisory, not an unreported clean result.

Windows x64 and ARM64 sandbox enforcement passed on the first pushed checkpoint
`5ba8f6f8` in GitHub run `33125942642`. The later checkpoint also exercises the
new complexity job. The PR links the final pushed head's complete CI results so
these earlier platform checks are not mistaken for final-head verification.

The merge-base comparison reports 13 source and one test function as new or
increased. Six source reports come from making unchanged declarations private.
The comparison deliberately reports visibility changes as unmatched declarations.
Those reports do not mean the implementation became more complex. The agent-loop
callback also moves when its test-only wrapper is removed. Actual increases in
notification, socket, snapshot migration, and ripgrep installation paths retain
the guards required by their reproduced ordering, ownership, persistence, and
cleanup failures. The PR records those reasons instead of extracting single-use
helpers to lower the numbers.

The local Linux matrix used the CI image pinned to
`sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07`
on `linux/amd64`, Bun `1.4.1-canary.1+731aa92da`, locked Playwright `1.62.1`,
and Electron `43.2.0`. A hash audit matched all 1,447 checked source/build files
to the tested mirror. The clean run made no snapshot updates. Its four opt-in
failure cases were skipped only in the normal matrix and passed separately by
producing the expected renderer, mention-geometry, visual, and Axe failures.

Android verification uses an isolated API 36 emulator and a temporary pinned-TLS
desktop fixture, not the connected physical phone or a real account. It covers
pairing input validation, trust persistence, authenticated event delivery,
conversation hydration, native tabs/detail navigation, saved-desktop swipes,
and foreground reconnection without pairing again. These checks do not claim
live model inference or manual TalkBack coverage. A second local fixture supplies
an active turn for native Stop verification: the request log records exactly one
interrupt and completion, and screenshots show the pending and restored controls.

At this checkpoint, native iOS simulator verification awaited Xcode MCP approval
of the isolated worktree folder. Dependency resolution and Metro exports did not
prove that the app built or ran. The follow-up below records the subsequent native
build and failed launch after worktree access became available.

## ai-slop-cleaner follow-up from `bcc432d3`

Scope: seven production modules and their tests, covering mobile bootstrap/MCP
state, desktop control sockets, mobile trusted-session projection, Google tool
events, and CLI provider-option commands. The report/comparison tooling was also
checked; its Git cleanup, diagnostics, and distinct exit-code contracts were
retained. This is a bounded follow-up to the repository inventory above.

Behavior lock: new cases run against the unchanged implementation before each
cleanup. The tests cover pagination and cached errors; readiness rejection,
timeout, late settlement, latest store ownership, and inherited model clearing;
selected-desktop transport fields and event ordering; Google tool flags, IDs,
arguments, and result envelopes; and CLI provider precedence, value validation,
aliases, request payloads, and failure/prompt behavior.

Cleanup plan: delete unused work first, consolidate one duplicate at a time,
preserve error handling and external contracts, then strengthen and rerun the
regression suite. No new runtime abstraction, dependency, or protocol change is
needed for these cleanups.

| Pass | Changed production files | Simplification |
| --- | --- | --- |
| Dead code | `apps/mobile/src/features/cowork/remoteThreadBootstrap.ts`, `apps/mobile/src/features/cowork/mcpStore.ts` | Remove an unused pagination slice and a refresh alias with no callers |
| Dead state and duplication | `apps/desktop/src/app/store.helpers/controlSocket.ts` | Remove an always-true memory flag; reuse the promise waiter; register current store bindings once |
| Duplication | `apps/mobile/src/features/relay/secureTransportClient.ts` | Use the existing trusted-desktop projection for pairing, reconnect, and restore |
| Duplication | `src/runtime/googleNative/nativeTools.ts`, `src/runtime/googleNative/stream/mapToStreamParts.ts` | Share identical native result bodies and tool-event construction while preserving distinct tool contracts |
| Duplication | `src/cli/repl/commandRouter.ts` | Share the repeated option-command path and remove its now-unnecessary provider wrapper |
| Naming/error handling | The same scoped paths | Retain existing messages, failure propagation, timeout behavior, and prompt ordering; no cosmetic rewrite |
| Test reinforcement | Seven corresponding test files | Add 134 cases and strengthen existing assertions; retain all prior regressions |

TypeScript product source is 158 lines smaller in this pass and 1,896 lines
smaller than the original in the source scope defined above. The CLI router's
cognitive score changes from 162 to 150, the Google event mapper from 95 to 92,
and the largest control-socket function from 161 to 160. The number of functions
above 15 stays at 710; the threshold count alone does not measure the removed
duplication.

Five-pass local quality gates: 8,489 tests pass across 719 files, with 27 existing skips;
root/harness/desktop/mobile typechecks, Biome lint/check, docs consistency, and
both mobile Hermes exports pass. Each of the five logical slices passes the full
repository CI lane before its commit. Independent review found no remaining
issue in the cleanup diffs. The generated JSON-RPC artifact remains byte-identical
at 1,076,304 bytes.

The five-pass inventory contains 2,681 tracked paths, 677,438 text lines,
and 1,893 Biome-scanned files. Knip still reports no unused files and the documented
106 export / 130 type candidates; its advisory nonzero exit is not a clean result
or a reason to suppress them.

Native iOS: Xcode now opens the isolated worktree and successfully builds the
app for the iPhone 17 Pro simulator on iOS 27.0. UIKit refuses to launch it:
`UIScene life cycle is required for apps built with this SDK.` Pairing, navigation,
and foreground-recovery checks therefore cannot run. A regression-tested,
independently reviewed single-scene migration proposal is prepared but not
applied. The xcode-mcp skill prohibits direct plist edits, and its plist tool
cannot represent the required root dictionary. A one-file `Info.plist` exception
has been requested; native runtime verification remains incomplete. The proposal
has not been compiled or run. The simulator interaction session and temporary
servers are closed, and existing simulator data is preserved. No physical phone
was used. The earlier native Android journeys remain separate evidence; this
follow-up reruns its JavaScript behavior tests and both Hermes exports.

Consciously retained: Codex completion/drain state, socket identity/disposal
guards, Google alias ownership, distinct web/URL/MCP result formats, public and
dynamic compatibility exports, and the separate mobile context readers whose
consolidation would introduce another dependency boundary. No helper extraction
was used solely to lower a cognitive score.

## Late PR review after `1ad4ea11`

All ten CI jobs passed on `1ad4ea11`, including 8,478 Linux unit tests across 719
files, the 59-test Electron matrix and four failure probes, and native sandbox
checks on macOS and both Windows architectures. Linux's 38 skips include 11
macOS-only Seatbelt cases that passed in the local suite. Two late review comments
were then checked against that commit before making further changes.

The Android XML asset finding did not reproduce. Installed Metro defaults already
include `xml`; Expo's source transformer and native vector loader support the
toolbar's XML path. [Expo documents this Icon support](https://docs.expo.dev/versions/latest/sdk/ui/jetpack-compose/icon/).
The actual project configuration, all six assets in the fresh Android export,
their hashes against the prior native captures, and 16 targeted tests provide
evidence beyond the mocked component tests. No asset or dependency change was
made for this finding; a release APK runtime check is not claimed.

The popup media finding was real: `fixtures.ts` applied media emulation only to
the initial page. A new `specs/media-modes.pw.ts` checks actual `matchMedia` values
on the initial window and a Canvas popup across all five quality modes. Before
the fix, three modes passed and reduced-motion/forced-colors failed on the popup.
The fixture now shares the existing media configuration and awaits emulation in
`openWindow` before returning the secondary page. All five cases then pass.
Independent review confirms that error propagation and window cleanup remain
intact; no product code, helper layer, or dependency was added.

Correct media emulation changes four forced-colors Canvas references: Markdown,
text, spreadsheet, and presentation. Each native Linux capture was visually
reviewed before copying it into the repository. System text colors, control
borders, and shadow handling now reflect forced-colors mode; content and layout
remain unchanged. All other screenshot baselines are byte-identical. Screenshot
tolerances, performance budgets, skip rules, and error filters are unchanged.

After code and baseline freeze, all 8,489 unit tests pass across 719 files, with
27 existing skips. Root/harness/desktop/mobile typechecks, standalone comparison
typechecking, Biome lint/check, and docs consistency pass. The clean Linux
Electron matrix passes 64 tests with four opt-in probes skipped; all four probes
pass separately by producing the expected failures and diagnostic artifacts.
The normal matrix makes no baseline updates, and the product screenshot check
passes. A hash audit matches all 1,989 relevant source, test, and build files to
the isolated Linux copy. Its image and toolchain match the pinned CI environment.

One negative-run cleanup recorded a Node-internal `timer._onTimeout` exception.
Its stack did not identify a cause in the changed files. Neither the focused
native green run nor the full 64-test matrix reproduced it; its cause remains
unconfirmed, and no ignore was added. The full matrix reports no unexpected main,
renderer, or network errors.

The final inventory in the table includes this review follow-up. Product-source
reduction remains 1,896 lines, and Knip remains at zero unused files plus 106
export and 130 type candidates. Native iOS runtime verification still requires
the explicit plist exception described above.
