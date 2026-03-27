#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

failures=0
runs=6
started_at="$(date +%s)"

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
    "resume-replay-${i}" \
    env CI=true bun test test/server.jsonrpc.flow.test.ts --max-concurrency 1 --test-name-pattern "thread/resume replays a journal cursor once before reattaching the live thread sink"
done

elapsed_s="$(( $(date +%s) - started_at ))"

echo "METRIC resume_replay_failures=${failures}"
echo "METRIC repro_runs=${runs}"
echo "METRIC elapsed_s=${elapsed_s}"

if [ "$failures" -ne 0 ]; then
  exit 1
fi
