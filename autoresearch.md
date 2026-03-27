# Autoresearch: CI test reliability

## Objective
Make the repository's unit-test/CI experience reliable:
- unit tests should pass under CI-like conditions,
- failures should not be flaky/order-dependent,
- fixes must improve real correctness rather than weakening or skipping tests,
- if gaps are uncovered, add or tighten tests so behavior is actually covered.

This session uses the real Bun test workload and CI-adjacent validation, not a synthetic proxy benchmark.

## Metrics
- **Primary**: `ci_failure_score` (failures, lower is better) — number of failed CI-like unit suite reruns in `./autoresearch.sh`.
- **Secondary**:
  - `unit_runs` — number of unit-suite reruns executed by the benchmark script.
  - `elapsed_s` — wall-clock runtime for the benchmark script.

A score of `0` means the unit suite passed on both reruns in the same workspace, which is the minimum standard for a candidate keep. Any passing benchmark is additionally validated by `./autoresearch.checks.sh` before it can be kept.

## How to Run
- Benchmark: `./autoresearch.sh`
- Correctness gate: `./autoresearch.checks.sh`

Both scripts print diagnostics on failure; the benchmark also prints structured `METRIC ...` lines.

## Files in Scope
- `.github/workflows/ci.yml` — CI job definition and test invocation.
- `package.json` — test/typecheck/docs scripts.
- `scripts/run_tests_stable.ts` — sequential/batched test runner useful for flake detection.
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
- Initial setup uses a benchmark that runs `bun test --max-concurrency 1` twice to detect immediate flakes without changing semantics.
- Passing benchmark runs are gated by docs/typecheck plus `bun run test:stable -- --max-concurrency 1` to catch file-order/global-state issues.
- Next step: establish the baseline and triage the first concrete failures.
