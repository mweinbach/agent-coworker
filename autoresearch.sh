#!/usr/bin/env bash
set -euo pipefail

started_at="$(date +%s)"
unsafe_count="$(python - <<'PY'
from pathlib import Path
files = [
  Path('test/desktop.controlSocket.threadList.test.ts'),
  Path('test/harness.ws.e2e.test.ts'),
  Path('test/server.jsonrpc.control.test.ts'),
  Path('test/server.jsonrpc.test.ts'),
  Path('test/server.test.ts'),
]
print(sum(p.read_text().count('server.stop();') for p in files))
PY
)"

elapsed_s="$(( $(date +%s) - started_at ))"

echo "METRIC unsafe_server_teardowns=${unsafe_count}"
echo "METRIC elapsed_s=${elapsed_s}"

if [ "$unsafe_count" -ne 0 ]; then
  exit 1
fi
