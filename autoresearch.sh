#!/usr/bin/env bash
set -euo pipefail

started_at="$(date +%s)"
unsafe_count="$(python - <<'PY'
from pathlib import Path
text = Path('test/server.jsonrpc.flow.test.ts').read_text()
print(text.count('await server.stop();'))
PY
)"

elapsed_s="$(( $(date +%s) - started_at ))"

echo "METRIC unsafe_jsonrpc_teardowns=${unsafe_count}"
echo "METRIC elapsed_s=${elapsed_s}"

if [ "$unsafe_count" -ne 0 ]; then
  exit 1
fi
