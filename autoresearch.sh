#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

log_file="$tmp_dir/ci-noise.log"
started_at="$(date +%s)"

set +e
CI=true bun test --max-concurrency 1 >"$log_file" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "[autoresearch] CI suite failed; last 80 lines:"
  tail -80 "$log_file"
  exit "$status"
fi

google_warning_lines="$(grep -F -c 'GoogleGenAI.interactions: Interactions usage is experimental and may change in future versions.' "$log_file" || true)"
observability_warning_lines="$(grep -F -c '[observability] Langfuse observability is enabled but base URL and credentials are not fully configured.' "$log_file" || true)"
expected_error_lines="$(grep -F -c 'error: state load exploded' "$log_file" || true)"
noise_lines=$((google_warning_lines + observability_warning_lines + expected_error_lines))
elapsed_s="$(( $(date +%s) - started_at ))"

echo "METRIC ci_noise_lines=${noise_lines}"
echo "METRIC google_warning_lines=${google_warning_lines}"
echo "METRIC observability_warning_lines=${observability_warning_lines}"
echo "METRIC expected_error_lines=${expected_error_lines}"
echo "METRIC elapsed_s=${elapsed_s}"
