# cowork-win-sandbox

Windows sandbox helper for `agent-coworker`. It is the Windows counterpart to
`/usr/bin/sandbox-exec` (macOS Seatbelt) and `bwrap` (Linux bubblewrap): the
TypeScript `SandboxManager` (`src/platform/sandbox/windows.ts`) prepends this
helper to a shell command so the command runs with reduced privilege inside a
Job Object.

## CLI contract

```
cowork-win-sandbox.exe \
  --mode <read-only|workspace-write> \
  [--writable-root <abs-path>]... \
  --cwd <abs-path> \
  [--allow-network] \
  -- <program> [args...]
```

The helper executes `<program> [args...]`, waits for it, and exits with the
child's exit code. Stdio is inherited (passthrough).

## What it enforces (v1)

- **Privilege reduction:** runs the child under a restricted (`LUA_TOKEN`) token
  derived from the current process token.
- **Containment:** assigns the child to a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  Job Object so the whole tree is terminated when the helper exits.

## Not yet implemented (tracked TODOs)

- **Per-root filesystem scoping** (`--writable-root` / `--mode`) via deny/allow
  ACLs or capability SIDs — currently informational.
- **Network isolation** (`--allow-network`) via the Windows Filtering Platform —
  currently informational.

These are the heavier parts of Codex's `windows-sandbox-rs`; they are the next
iteration. Until then, the TypeScript sandbox manager treats restrictive Windows
policies as backend-unavailable rather than claiming filesystem or network
isolation. With the default `sandbox.requireBackend: true`, that fails closed;
users may explicitly opt into unsandboxed execution by setting it to `false`.

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

## Verification checklist (Windows runner)

1. `cargo build --release` succeeds.
2. `cowork-win-sandbox.exe --mode read-only --cwd . -- cmd /c whoami` runs and
   reports a restricted/medium-or-lower token.
3. The child is killed when the helper process is terminated (Job Object).
4. Exit codes propagate correctly.
