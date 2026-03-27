#!/usr/bin/env bash
set -euo pipefail

started_at="$(date +%s)"
failures=0

if ! grep -q 'run: bun run typecheck' .github/workflows/ci.yml; then
  failures=$((failures + 1))
fi
if ! grep -q 'run: bun run test:stable -- --max-concurrency 1' .github/workflows/ci.yml; then
  failures=$((failures + 1))
fi
if ! grep -q 'run: bun test --max-concurrency 1' .github/workflows/ci.yml; then
  failures=$((failures + 1))
fi
if ! grep -q 'run: bun run docs:check' .github/workflows/ci.yml; then
  failures=$((failures + 1))
fi

elapsed_s="$(( $(date +%s) - started_at ))"

echo "METRIC ci_guardrail_failures=${failures}"
echo "METRIC elapsed_s=${elapsed_s}"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
