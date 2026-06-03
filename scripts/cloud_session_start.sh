#!/usr/bin/env bash
#
# SessionStart hook for Claude Code on the web (cloud sessions).
#
# Cloud sessions start from a fresh clone with no node_modules, so Claude can't
# run `bun test`, `bun run typecheck`, or edit-and-verify without dependencies.
# This hook installs them on the cloud VM only. It is a no-op locally so your
# terminal sessions are never slowed down.
#
# Configured in .claude/settings.json (committed to the repo) so it runs in every
# cloud session per the Claude Code web guide:
#   https://code.claude.com/docs/en/web  (Setup scripts vs. SessionStart hooks)
#
# NOTE ON BUN + THE SECURITY PROXY:
#   All cloud outbound traffic passes through Anthropic's security proxy, and Bun
#   has known proxy-compatibility issues for package fetching. We mitigate by:
#     - pointing Bun at the system CA bundle (the proxy intercepts TLS),
#     - using --frozen-lockfile (fewer registry roundtrips; we have bun.lock),
#     - retrying once on a flaky fetch.
#   If you want the heavier codex/artifact runtimes preinstalled and *cached*
#   across sessions, put `bun install` in the cloud environment's Setup script
#   (web UI) instead — setup-script output is cached; SessionStart hooks are not.

set -uo pipefail

# Only run in Claude Code on the web. Local/CLI sessions exit immediately.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" || exit 0

# Stamp file recording the bun.lock content hash that the current node_modules
# was installed from. We key the fast-path skip on this hash — NOT on mere
# directory existence — so a changed lockfile (dep bump, new package, an older
# env-cache snapshot) always forces a reinstall instead of silently running
# against stale or partial node_modules.
STAMP="node_modules/.cloud-install-stamp"

lockfile_hash() {
  # Prefer sha256sum (present on the Ubuntu cloud image); fall back to shasum.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum bun.lock 2>/dev/null | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 bun.lock 2>/dev/null | cut -d' ' -f1
  fi
}

stamp_install() {
  # Re-hash AFTER install: a non-frozen `bun install` may have rewritten bun.lock,
  # so the stamp must reflect the lock that node_modules actually matches.
  local h
  h="$(lockfile_hash)"
  [ -n "$h" ] && printf '%s\n' "$h" >"$STAMP"
}

# Fast path: node_modules exists AND was installed from this exact bun.lock.
WANT_HASH="$(lockfile_hash)"
if [ -d node_modules ] && [ -n "$WANT_HASH" ] && [ -f "$STAMP" ] && \
   [ "$(cat "$STAMP" 2>/dev/null)" = "$WANT_HASH" ]; then
  echo "[cloud-setup] node_modules matches bun.lock; skipping bun install"
  exit 0
fi

# Help Bun's installer validate TLS through the proxy's MITM by trusting the
# system CA bundle. Skip silently if no bundle is found.
for ca in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
  if [ -f "$ca" ]; then
    export NODE_EXTRA_CA_CERTS="$ca"
    break
  fi
done

# Skip the postinstall codex/artifact runtime downloads. They're only needed to
# *run* the cowork agent itself, not to edit/typecheck/test this repo, and they'd
# add network-dependent latency to every cloud session start. The root workspace
# install already covers apps/* and packages/* deps.
export SKIP_POSTINSTALL=1

# --frozen-lockfile is the correctness lever: it makes node_modules match
# bun.lock EXACTLY — installs anything missing and fails loudly if the committed
# lockfile is itself out of sync with package.json — so we never end up "missing"
# or "outdated" relative to what the repo pins.
echo "[cloud-setup] installing dependencies with bun (frozen lockfile)…"
if bun install --frozen-lockfile; then
  stamp_install
  echo "[cloud-setup] dependencies installed"
  exit 0
fi

# Retry without --frozen: covers a transient proxy fetch failure, and also the
# case where the committed bun.lock legitimately lagged package.json (bun will
# reconcile and rewrite the lock). We re-stamp against the post-install lock.
echo "[cloud-setup] frozen install failed (proxy flakiness or stale lock?); retrying once…"
if bun install; then
  stamp_install
  echo "[cloud-setup] dependencies installed on retry"
  exit 0
fi

# Don't hard-fail the session: a non-zero SessionStart hook shouldn't block
# Claude from starting. Surface the failure loudly so Claude can re-run install.
echo "[cloud-setup] WARNING: bun install failed; deps are missing. Run 'bun install' before tests." >&2
exit 0
