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

failures=0
runs=200
started_at="$(date +%s)"

ensure_merge_worktree

autorepro() {
  local label="$1"
  shift
  local log_file="$tmp_dir/${label}.log"

  echo "[autoresearch] running ${label}: $*"
  set +e
  "$@" >"$log_file" 2>&1
  local status=$?
  set -e

  echo "[autoresearch] ${label} exit=${status}"
  if [ "$status" -ne 0 ]; then
    failures=$((failures + 1))
    echo "[autoresearch] ${label} failed; last 80 lines:"
    tail -80 "$log_file"
  fi
}

for i in $(seq 1 "$runs"); do
  autorepro \
    "pr61-merge-resume-${i}" \
    bash -lc "cd '$worktree_dir' && CI=true bun test test/server.jsonrpc.flow.test.ts --max-concurrency 1 --test-name-pattern 'thread/resume replays a journal cursor once before reattaching the live thread sink'"
done

elapsed_s="$(( $(date +%s) - started_at ))"

echo "METRIC merge_resume_failures=${failures}"
echo "METRIC merge_resume_runs=${runs}"
echo "METRIC elapsed_s=${elapsed_s}"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
