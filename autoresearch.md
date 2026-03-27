# Autoresearch: CI test reliability

## Objective
Make the repository's unit-test/CI experience reliable:
- unit tests should pass under CI-like conditions,
- failures should not be flaky/order-dependent,
- fixes must improve real correctness rather than weakening or skipping tests,
- if gaps are uncovered, add or tighten tests so behavior is actually covered.

This session uses the real Bun test workload and CI-adjacent validation, not a synthetic proxy benchmark.

## Metrics
- **Primary**: `merge_resume_failures` (failures, lower is better) — number of failures across repeated CI-like reruns of the exact flaky `thread/resume` JSON-RPC test on the PR #61 merge ref in `./autoresearch.sh`.
- **Secondary**:
  - `merge_resume_runs` — number of merge-ref targeted reproducer runs executed by the benchmark script.
  - `elapsed_s` — wall-clock runtime for the benchmark script.

A score of `0` means the exact flaky test survived all targeted reruns. Any passing benchmark is additionally validated by `./autoresearch.checks.sh`, which runs docs, typecheck, the exact merge-ref CI unit-suite invocation, and the merge-ref per-file stable runner before a result can be kept.

## How to Run
- Benchmark: `./autoresearch.sh`
- Correctness gate: `./autoresearch.checks.sh`

Both scripts print diagnostics on failure; the benchmark also prints structured `METRIC ...` lines.

## Files in Scope
- `.github/workflows/ci.yml` — CI job definition and test invocation.
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
- Current focus: hammer the exact flaky `thread/resume` test 200 times on the PR merge ref under `CI=true` so the low-frequency race becomes measurable without paying for hundreds of full-suite runs.
