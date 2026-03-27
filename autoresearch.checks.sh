#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")" && pwd)"
worktree_dir="/tmp/agent-coworker-pr61"
merge_ref="refs/tmp/pr61-merge"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

ensure_merge_worktree() {
  git -C "$repo_root" fetch origin pull/61/merge:"$merge_ref" >/dev/null 2>&1
  if [ ! -e "$worktree_dir/.git" ]; then
    rm -rf "$worktree_dir"
    git -C "$repo_root" worktree add --detach "$worktree_dir" "$merge_ref" >/dev/null 2>&1
  else
    git -C "$worktree_dir" reset --hard "$merge_ref" >/dev/null 2>&1
    git -C "$worktree_dir" clean -fd >/dev/null 2>&1
  fi

  [ -e "$worktree_dir/node_modules" ] || ln -s "$repo_root/node_modules" "$worktree_dir/node_modules"
  [ -e "$worktree_dir/apps/desktop/node_modules" ] || ln -s "$repo_root/apps/desktop/node_modules" "$worktree_dir/apps/desktop/node_modules"
  [ -e "$worktree_dir/apps/mobile/node_modules" ] || ln -s "$repo_root/apps/mobile/node_modules" "$worktree_dir/apps/mobile/node_modules"
}

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

ensure_merge_worktree

run_check docs bash -lc "cd '$worktree_dir' && bun run docs:check"
run_check typecheck bash -lc "cd '$worktree_dir' && bun run typecheck"
run_check ci-unit bash -lc "cd '$worktree_dir' && CI=true bun test --max-concurrency 1"
run_check stable bash -lc "cd '$worktree_dir' && bun run test:stable -- --max-concurrency 1"

if [ "${RUN_REMOTE_MCP_TESTS:-0}" = "1" ] && [ -n "${OPENCODE_API_KEY:-}" ]; then
  run_check remote-mcp bash -lc "cd '$worktree_dir' && bun test test/mcp.remote.grep.test.ts"
else
  echo "[checks] skipping remote MCP smoke; RUN_REMOTE_MCP_TESTS/OPENCODE_API_KEY not set"
fi
