# Autoresearch: CI test reliability

## Objective
Make the repository's unit-test/CI experience reliable:
- unit tests should pass under CI-like conditions,
- failures should not be flaky/order-dependent,
- fixes must improve real correctness rather than weakening or skipping tests,
- if gaps are uncovered, add or tighten tests so behavior is actually covered.

This session uses the real Bun test workload and CI-adjacent validation, not a synthetic proxy benchmark.

## Metrics
- **Primary**: `ci_noise_lines` (count, lower is better) — number of known noisy-but-non-failing log lines emitted by one `CI=true bun test --max-concurrency 1` run in `./autoresearch.sh`.
- **Secondary**:
  - `google_warning_lines` — count of repeated Google GenAI experimental warnings.
  - `observability_warning_lines` — count of repeated Langfuse degraded-config warnings.
  - `expected_error_lines` — count of expected test-path error logs that should be locally suppressed in tests.
  - `elapsed_s` — wall-clock runtime for the benchmark script.

A score of `0` means the full CI-style unit suite runs without emitting the currently-known noisy warnings/errors. Any passing benchmark is additionally validated by `./autoresearch.checks.sh`, which runs docs, typecheck, the exact CI unit-suite invocation, and the per-file stable runner before a result can be kept.

## How to Run
- Benchmark: `./autoresearch.sh`
- Correctness gate: `./autoresearch.checks.sh`

Both scripts print diagnostics on failure; the benchmark also prints structured `METRIC ...` lines.

## Files in Scope
- `.github/workflows/ci.yml` — main CI job definition and test invocation.
- `package.json` — test/typecheck/docs scripts.
- `scripts/run_tests_stable.ts` — sequential/batched test runner useful for flake detection.
- `test/ci.workflow.test.ts` — workflow regression coverage for CI guardrails.
- `test/**/*.test.ts` — unit tests and helpers.
- `test/shared/**` — shared test utilities/diagnostics.
- `src/**` — production code implicated by failing or flaky tests.
- `docs/**` / `scripts/check_docs.ts` — documentation consistency checks run by CI.

## Off Limits
- Do not delete/skip/weaken tests just to get green.
- Do not change the benchmark/check scripts to hide failures.
- Do not add network dependence to unit tests.
- Do not overfit to a single failing seed/run while making overall reliability worse.

## Constraints
- Use the repository's real CI-style commands.
- Keep fixes minimal and reversible.
- `bun test`, docs checks, and typecheck must remain meaningful.
- Prefer deterministic tests with isolated filesystem/state.
- No benchmark cheating.

## What's Been Tried
- Initial local baseline was green: `bun test --max-concurrency 1` succeeded twice, and docs/typecheck plus `bun run test:stable -- --max-concurrency 1` also passed.
- GitHub PR #61 revealed the real failing signal to optimize against: workflow `CI` / job `Docs + Tests` timed out in `server JSON-RPC flows > thread/resume replays a journal cursor once before reattaching the live thread sink`.
- The single-test reproducer stayed green locally across 6 reruns, and the whole `test/server.jsonrpc.flow.test.ts` file also stayed green locally across 8 reruns.
- Key discovery: PR #61 targets `cursor/mobile-remote-access-3f82`, so GitHub tested the merge ref, not just the head commit. The merge ref includes substantial changes in `src/server/jsonrpc/**`, `src/server/session/**`, and `test/server.jsonrpc.flow.test.ts` that can affect this failure.
- Breakthrough: the merge-ref unit suite passed twice in the benchmark but the next merge-ref CI-style suite run in checks reproduced the exact 45s timeout, confirming a real intermittent flake on the PR merge ref.
- The merge-ref stress harness proved the race is intrinsic to the exact `thread/resume` test path: 17 failures in 200 targeted CI-like reruns.
- Kept fix: `await server.stop(true)` in the flaky test cleanup reduced the current-repo stress benchmark from 1/100 failures to 0/100, and a second 0/100 confirmation run increased confidence.
- Kept follow-up: main CI now runs typecheck and the stable per-file unit test pass, and `test/ci.workflow.test.ts` locks those guardrails in.
- Kept follow-up: the websocket-heavy JSON-RPC flow spec now uses a shared forced-close teardown helper (`stopTestServer`) instead of plain `await server.stop();`.
- Kept follow-up: `test/server.toolstream.test.ts` now also uses `stopTestServer`, removing its 2 plain-stop teardown callsites.
- Kept follow-up: the remaining 48 plain-stop teardown callsites across `test/server.jsonrpc.control.test.ts`, `test/server.jsonrpc.test.ts`, `test/harness.ws.e2e.test.ts`, `test/desktop.controlSocket.threadList.test.ts`, and `test/server.test.ts` have been replaced with `stopTestServer()`.
- Kept follow-up: the final 2 plain-stop teardown callsites in the persisted/live handoff test inside `test/server.jsonrpc.flow.test.ts` have also been removed.
- Kept follow-up: 5 repeated `CI=true bun test --max-concurrency 1` full-suite runs passed after the teardown and workflow hardening.
- Kept follow-up: repeated `bun run test:stable -- --max-concurrency 1` passes are also clean, including a confirmation rerun.
- Current focus: reduce noisy but passing CI log output (`GoogleGenAI.interactions` experimental warnings, Langfuse degraded-config warnings, and expected test-path error logs) so real failures are easier to spot.
