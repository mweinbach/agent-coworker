#!/usr/bin/env bash
# Cloud-only SessionStart hook. The full test suite needs both the root workspace
# and the independently locked mobile SDK; apps/mobile is not a root workspace.
# The versioned Cowork runtime is activated separately by the harness.

set -uo pipefail

# Only run in Claude Code on the web. Local/CLI sessions exit immediately.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

# Help Bun's installer validate TLS through the proxy's MITM by trusting the
# system CA bundle. Skip silently if no bundle is found.
for ca in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
  if [ -f "$ca" ]; then
    export NODE_EXTRA_CA_CERTS="$ca"
    break
  fi
done

# Skip optional postinstall work, not either dependency root.
export SKIP_POSTINSTALL=1

dependency_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum bun.lock package.json 2>/dev/null
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 bun.lock package.json 2>/dev/null
  else
    return 1
  fi
}

install_dependencies() (
  # A subshell keeps each root's cwd and cache state independent.
  cd "$1" || exit 1
  stamp="node_modules/.cloud-install-stamp"
  wanted_hash="$(dependency_hash)" || wanted_hash=""
  if [ -d node_modules ] && [ -n "$wanted_hash" ] && [ -f "$stamp" ] && \
     [ "$(cat "$stamp" 2>/dev/null)" = "$wanted_hash" ]; then
    echo "[cloud-setup] $1 dependencies match the lockfile; skipping install"
    exit 0
  fi

  for attempt in 1 2; do
    echo "[cloud-setup] installing $1 dependencies (frozen lockfile, attempt $attempt)…"
    if bun install --frozen-lockfile; then
      if [ -n "$wanted_hash" ]; then
        mkdir -p node_modules
        printf '%s\n' "$wanted_hash" > "$stamp"
      fi
      echo "[cloud-setup] $1 dependencies installed"
      exit 0
    fi
  done

  echo "[cloud-setup] WARNING: $1 dependencies are missing; resolve the frozen install failure before tests." >&2
  exit 1
)

# Don't hard-fail the session: a non-zero SessionStart hook shouldn't block
# startup. Retry transient failures without rewriting either committed lockfile.
install_dependencies "." || true
install_dependencies "apps/mobile" || true
exit 0
