#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

run_check() {
  local label="$1"
  shift
  local log_file="$tmp_dir/${label}.log"

  echo "[checks] ${label}: $*"
  if "$@" >"$log_file" 2>&1; then
    return 0
  fi

  echo "[checks] ${label} failed; last 80 lines:"
  tail -80 "$log_file"
  return 1
}

run_check docs bun run docs:check
run_check typecheck bun run typecheck
run_check ci-unit env CI=true bun test --max-concurrency 1
run_check stable bun run test:stable -- --max-concurrency 1

if [ "${RUN_REMOTE_MCP_TESTS:-0}" = "1" ] && [ -n "${OPENCODE_API_KEY:-}" ]; then
  run_check remote-mcp bun test test/mcp.remote.grep.test.ts
else
  echo "[checks] skipping remote MCP smoke; RUN_REMOTE_MCP_TESTS/OPENCODE_API_KEY not set"
fi
