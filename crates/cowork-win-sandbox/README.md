# cowork-win-sandbox

Windows sandbox helper for `agent-coworker`. It is the Windows counterpart to
`/usr/bin/sandbox-exec` (macOS Seatbelt) and `bwrap` (Linux bubblewrap): the
TypeScript `SandboxManager` (`src/platform/sandbox/windows.ts`) prepends this
helper to a shell command so the command runs with reduced privilege inside a
Job Object.

## CLI contract

```
cowork-win-sandbox.exe run \
  --mode <read-only|workspace-write> \
  [--writable-root <abs-path>]... \
  --cwd <abs-path> \
  --sandbox-home <abs-path> \
  [--allow-network] \
  -- <program> [args...]
```

The helper executes `<program> [args...]`, waits for it, and exits with the
child's exit code. Stdio is inherited (passthrough).

## Enforcement and setup

The runner uses the pinned Codex Windows sandbox engine for capability-SID ACLs,
dedicated online/offline identities, Windows Filtering Platform rules, restricted
tokens, and a kill-on-close Job Object. Writable roots and network policy are
enforced, not informational flags. Protected workspace metadata remains outside
the writable set.

`setup` provisions the managed sandbox home. `probe` checks readiness and exercises
allowed writes, denied outside/metadata/junction writes, child-process writes,
temporary scratch access, and network denial. The TypeScript adapter requires
the capability probe to succeed before advertising enforcement; with
`sandbox.requireBackend: true`, an unavailable backend fails closed.

Cowork manages setup state only in `~/.cowork` and its managed app-server home.
Do not import setup state from a separate native Codex installation. See
`src/platform/sandbox/windowsSetupSync.ts` and `docs/sandbox.md` for the shared
account and policy contracts.

## Build

The Linux/macOS dev environment has no Windows target, so the Win32 code is
`#[cfg(windows)]`-gated and must be built + verified on Windows:

```powershell
cargo build --release --target x86_64-pc-windows-msvc
```

The resulting `cowork-win-sandbox.exe` should be bundled next to the app binary
(or its `resources/` dir). The runtime locates it via, in order:

1. the `COWORK_WIN_SANDBOX_HELPER` environment variable (absolute path), or
2. the directory of the running binary / the app `resources` directory.

## Prebuilt release helpers

Desktop packaging (`scripts/build_desktop_resources.ts`) prefers downloading
prebuilt helpers over compiling this crate, because the cargo build (git deps
from `openai/codex`, `opt-level = "z"` + LTO) dominates release wall-clock time.

- `prebuilt.lock.json` (checked in next to this README) pins a `win-sandbox-v*`
  GitHub release tag, a content-based fingerprint of this crate's build inputs
  (`Cargo.toml`, `Cargo.lock`, `build.rs`, `codex-windows-sandbox-setup.manifest`,
  `src/`, `vendor/`; CRLF-normalized so checkouts hash identically), and sha256
  hashes for each per-target zip and helper exe.
- When the local fingerprint matches the lock, the build downloads the zip for
  the requested MSVC target, verifies the zip and every exe against the lock,
  and writes the same `cowork-win-sandbox.sha256.json` manifest a source build
  would produce. Signing and post-signing re-hashing are unchanged.
- Any soft miss — no lock, fingerprint drift after a crate edit, missing target,
  unavailable release asset — falls back to the cargo source build. A hash
  mismatch with a *matching* fingerprint is a hard failure by design: it means
  the release asset no longer contains the bytes the lock promised, so the build
  stops instead of masking a possible supply-chain problem.
- Escape hatches: `COWORK_WIN_SANDBOX_PREBUILT=0` disables prebuilt downloads;
  `--force-windows-sandbox-build` (the desktop `dev` script) always compiles.

Publishing flow (`.github/workflows/win-sandbox-release.yml`): push a
`win-sandbox-v*` tag (keep it in sync with the crate version) → the workflow
builds both MSVC targets, publishes the zips as release assets, and prints the
refreshed `prebuilt.lock.json` in the job summary → commit that file here.
Until the new lock is committed, desktop releases transparently compile from
source. `bun scripts/winSandboxPrebuilt.ts fingerprint|check|lock` exposes the
same logic on the command line.

## Verification checklist (Windows runner)

1. `cargo build --release` succeeds.
2. Run `setup` and `probe` with absolute `--cwd` and `--sandbox-home` paths;
   require the enforcement probe to report readiness.
3. Run the platform sandbox enforcement integration tests used by CI, including
   denied outside/metadata/junction writes and network access.
4. Verify child-process containment and exit-code propagation.

Formatting checks on macOS/Linux do not verify Windows enforcement. The Windows
CI lane builds all helper binaries and runs the real setup and enforcement tests.
