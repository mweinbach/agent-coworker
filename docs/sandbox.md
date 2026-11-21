# Sandbox

`agent-coworker` runs model-issued shell commands inside an OS-level sandbox.
This is the enforcement boundary for what a `bash` command may read, write, and
reach on the network — it replaces the previous parse-based command filtering,
which was bypassable and never enforced at the OS level.

The design is modeled on [OpenAI Codex](https://github.com/openai/codex): a
platform-agnostic policy plus dedicated per-platform backends, all flowing
through one `transform()` that prepends a sandbox wrapper to the command argv.

## Architecture

```
crates/cowork-sandbox/
  src/policy.rs           SandboxPolicy + resolution from role/config + writable roots
  src/protected_paths.rs  Cached .git/.cowork exclusions (ignore + notify watcher)
  src/manager.rs          SandboxManager::transform(...) + cowork-server __sandbox-exec
  src/seatbelt.rs         macOS: /usr/bin/sandbox-exec -p <.sbpl> -D... -- <cmd>
  src/bwrap.rs            Linux: bwrap <mounts> --unshare-net? -- <cmd>
  src/linux_seccomp.rs    Linux: native Rust pre_exec seccomp-BPF syscall filter (zero Python)
  src/windows.rs          Windows: in-process Microsoft Execution Containers (MXC / mxc-sdk ProcessContainer)
  src/detect.rs           Capability probes (sandbox-exec / bwrap / Windows MXC PSEC)
  src/denial.rs           Structured network vs filesystem denial classification
```

`SandboxManager` (`crates/cowork-sandbox/src/manager.rs`) is the single abstraction every platform flows through. Given the command argv and a policy it selects a backend (`macos-seatbelt` | `linux-bwrap` | `windows-sandbox` | `none`) and wraps or runs it directly in-process via MXC on Windows (with `cowork-server __sandbox-exec --windows-mxc` for CLI/print-command invocations), mirroring Codex's `SandboxManager::transform`. The bash tool (`crates/cowork-tools/src/bash.rs`) and `SofficeRunner` (`crates/cowork-env/src/soffice.rs`) wrap commands before spawning and attach marker env vars (`COWORK_SANDBOX`, `COWORK_SANDBOX_NETWORK_DISABLED`) to the child.

## Policy model

`SandboxPolicy` (`crates/cowork-sandbox/src/policy.rs`), adopted from Codex:

| Policy | Filesystem | Network |
|--------|-----------|---------|
| `read-only` | full disk read, no writes | per `network` |
| `no-project-write` | full disk read; temp scratch writable; no project writable roots | per `network` |
| `workspace-write` | full read; writes limited to `writableRoots` (cwd, output dir, Cowork tool runtime caches, child `targetPaths`) + temp; `.git`/`.cowork` stay read-only | per `network` |
| `danger-full-access` | unrestricted (no sandbox) | unrestricted |

The policy is resolved per turn in `crates/cowork-harness/` and `crates/cowork-tools/src/context.rs` from the agent role and config:
read-only roles (`explorer`, `research`, `reviewer`) → `no-project-write` so
verifier tooling can use temp files without mutating the workspace; write-capable
roles → `workspace-write`. Explicit `sandbox.mode: "read-only"` stays fully
immutable. Child-agent `targetPaths` become the writable roots, so write scope is
enforced by the OS rather than by parsing the command.

YOLO mode (`--yolo` / the desktop workspace toggle) lifts an unscoped,
non-read-only session to `danger-full-access` — commands run outside the OS
sandbox with full file and network access, and every approval (ordinary and
sandbox-escalation alike) auto-approves, so nothing prompts. The hard floors
above are unaffected: an explicit `read-only` mode, read-only roles, and scoped
children (`targetPaths`) keep their sandbox even under YOLO. An explicit
`sandbox.network: false` is also a floor: YOLO keeps the ban
(`danger-full-access` + `network: false`), and because YOLO never prompts, a
host without a network-enforcing backend fails closed instead of falling back
to an unsandboxed (network-capable) run.

Reads on macOS and Linux are full-disk (minus explicit credential denies), while
Windows MXC `ProcessContainer` is deny-by-default for reads and explicitly grants
the workspace, discovered skill/plugin read roots, non-credential `~/.cowork/{skills,plugins,runtime,config}`,
built-in/managed runtime paths, and MXC's discovered tool/profile read-only paths.
Global skills/plugins/config under `~/.cowork` (e.g. `~/.cowork/skills`, `~/.cowork/plugins`), built-in/bundled
skill assets, and any skill/plugin scripts the agent runs via `bash` remain
readable and runnable inside the sandbox — they are just read-only (writes there
are denied, as `~/.cowork` lives outside the writable roots and `.cowork` is
protected metadata). The built-in `read`/`glob`/`grep` tools mirror this:
`read_roots` (`crates/cowork-tools/src/context.rs`) includes discovered skill dirs,
workspace/user plugin dirs, and every discovered plugin root + its declared skill
paths, and reads outside the project are not constrained by a scoped child's
`targetPaths`, so scoped agents can still load global skills and plugins.

The versioned Cowork runtime under `~/.cowork/runtime/<date>` is immutable and
remains read-only in sandboxed turns. Node, Python, native tools, and runtime
libraries are read directly from that verified tree; marketplace-installed
skills and plugins remain in project/user `.cowork` roots. Generated artifacts
and temporary dependency state belong in the workspace or scratch directories.

Note on namespaces: the canonical runtime skill/plugin roots are `.cowork/` and
`~/.cowork/` (project + user) plus the built-in dir. `.agents/` is the
marketplace/curated-repo *source* layout (e.g. `.agents/plugins/marketplace.json`)
and is not a runtime skill/plugin lookup path, so the file tools do not treat
`~/.agents/skills` or `~/.agents/plugins` as read roots. A `bash` command can still
read them (reads are full-disk), but the harness never loads skills or plugins
from there — install them under `~/.cowork/...` to make them first-class.

`targetPaths` are clamped to the workspace: entries that resolve outside it (e.g.
an absolute `/home/user/.ssh`) or inside protected metadata (`.git`/`.cowork`) are
dropped so they never become shell-writable. A spawn whose `targetPaths` all drop
out is rejected up front with a clear error rather than running a child that can
write nowhere useful. When a not-yet-existing scoped target is a directory whose
name looks file-like (for example `artifacts/v1.0/`), keep the trailing slash so Linux
creates a directory bind source rather than an empty file.

## Configuration

`config.sandbox` (built-in default in `config/defaults.json`):

```json
{ "sandbox": { "mode": "workspace-write", "network": true, "requireBackend": false } }
```

- `mode`: `auto` | `read-only` | `workspace-write` | `danger-full-access`
- `network`: allow outbound network inside the sandbox (default `true`)
- `requireBackend`: fail closed when the selected OS sandbox backend is unavailable
  or cannot enforce filesystem/network scope (default `false`; set `true` to fail
  closed instead of allowing an explicitly degraded fallback). With the default
  `false`, hard-floor contexts still fail closed and a missing, stale, or
  integrity-failed backend requires explicit unsandboxed approval before running
  and surfaces a `[sandbox] …` warning.
- env override: `AGENT_SANDBOX=<mode>`

## Escalate-on-failure

There is no pre-run command prompt. Commands run inside the sandbox silently. If
a sandboxed command fails in a way that looks like a sandbox denial
(`crates/cowork-sandbox/src/denial.rs` — "operation not permitted", "read-only file
system", "seccomp"/"landlock", etc.), the bash tool asks the user (via the
`approval` event, reason `sandbox_denied_escalation`) whether to re-run it with
`danger-full-access`. Unsandboxed fallback because a backend is unavailable uses
the same protected sandbox-denial approval path, since it also grants full
filesystem access. This mirrors Codex's `with_escalated_permissions` flow.
Under YOLO these escalations auto-approve (YOLO is zero-prompt); the bash tool
never offers an escalation for read-only policies or scoped children, so YOLO
cannot widen those floors.

Codex app-server approval requests enforce the same hard floors before YOLO or
manual approval, and recheck them after an approval wait. Scoped file grants
must name a permitted root and targets; ambiguous escalation requests fail closed.
Codex's wire-level `dangerFullAccess` cannot disable networking, so network-disabled
full-access turns use a narrower workspace-write policy. Both the Codex adapter
and the Windows MXC backend disable implicit temp grants and use explicitly filtered
scratch roots, preventing a temp-based checkout from regaining blanket temp writes.

## Per-platform backends

- **macOS — Seatbelt** (`crates/cowork-sandbox/src/seatbelt.rs`): generates a `.sbpl` profile (deny-by-default
  base + dynamic `file-read*`/`file-write*`/network sections, `-D` path params)
  and runs it under `/usr/bin/sandbox-exec`. Pure string/argv generation. Protected
  metadata (`.git`/`.cowork`) is excluded per writable root via `-D` subpath
  params (so the exclusion is relative to the root — a workspace that merely lives
  under a `.cowork` ancestor, e.g. `~/.cowork/chats/<id>`, is not wrongly denied):
  the direct `.git`/`.cowork` children plus any existing nested ones, matching the
  bwrap backend. Capability detection accepts only the fixed, root-owned,
  non-writable `/usr/bin/sandbox-exec` after its Apple code signature verifies.
- **Linux — bubblewrap** (`crates/cowork-sandbox/src/bwrap.rs`): `--ro-bind / /` for reads, `--bind` per
  writable root, `--ro-bind` to re-protect `.git`/`.cowork`, `--unshare-net` when
  network is restricted, plus user/pid namespaces and a fresh `/proc`. `bwrap` is
  resolved only from trusted system dirs (`/usr/bin`, `/bin`, …) or an absolute
  `COWORK_BWRAP_PATH` — never `$PATH` — so a workspace-planted binary can't hijack
  it. If absent the default `sandbox.requireBackend: false` surfaces an
  unsandboxed fallback approval for unscoped workspace-write commands; set
  `sandbox.requireBackend: true` to fail closed instead.
  In `crates/cowork-sandbox/src/linux_seccomp.rs`, `cowork-server __sandbox-exec`
  assembles and installs an inherited native classic-BPF seccomp syscall filter
  directly in Rust (`pre_exec` + `bwrap --seccomp`) with zero `/usr/bin/python3`
  dependency. It denies Unix socket creation and `io_uring`, rejects foreign
  syscall ABIs, and permits only anonymous Unix stream socketpairs.
  Datagram socketpairs are denied because they can reconnect to host sockets.
  This also applies with TCP networking enabled: SSH-agent/Docker pathname IPC
  is not available to restricted commands. A filter installation error fails
  closed. Native x86-64 and AArch64 are supported.
  **Limitation:** the `.git`/`.cowork` re-protection is bind-based. It re-freezes
  metadata directories that already exist under explicit writable roots, including
  nested submodule/worktree metadata, but it does not fabricate missing metadata
  mountpoints because doing so can create host directories during sandbox setup.
  Prefer narrow `targetPaths` when a child must not create new metadata paths.
- **Windows — Microsoft Execution Containers (MXC)** (`crates/cowork-sandbox/src/windows.rs`, `mxc-sdk`):
  runs commands directly in-process inside a Windows `ProcessContainer` backed by
  the native OS Process Security Environment (`processmodel.dll` PSEC, Windows 11
  24H2 build 26100.9278+ / 25H2 / 26H1 / 26H2). There are no bundled Windows
  sandbox sidecar executables, no local `CodexSandboxOffline/Online` user accounts,
  and no elevated UAC setup step.

  `probe_windows_mxc_sandbox` calls `mxc_sdk::v1::probe(None)` (30s TTL cache)
  to verify `base_container_api_present` and detect optional `deniedPaths` support.
  On hosts without native PSEC support, capability detection reports `none` so
  hard floors and `sandbox.requireBackend: true` fail closed (`SANDBOX_REQUIRED`)
  and non-hard-floor `workspace-write` prompts for explicit unsandboxed approval.

  Each execution constructs an explicit `FilesystemPolicy` (`readwritePaths`,
  `readonlyPaths`, `deniedPaths`), directional `NetworkPolicy` (egress + ingress +
  host loopback allow/deny), locked clipboard/input `UiPolicy` (with Win32k kept
  enabled so tools linking `user32`/`gdi32` such as headless LibreOffice work),
  and an explicit secret-stripped child environment (`inherit_default_environment: false`)
  guaranteeing `SystemRoot` and `LOCALAPPDATA`. Because Windows BaseContainer
  resolves overlapping grants by longest-prefix match, `.git` and `.cowork`
  (direct and nested via `WorkspaceProtectedPathsCache`) are placed in
  `readonlyPaths`, while credential `read_denied_roots` are placed in `deniedPaths`
  (when supported by host PSEC) and stripped from all read/write grants.

  Note: OpenAI's external `codex-app-server` runtime still manages its own
  upstream companion binaries under `~/.cowork/auth/codex-cli`
  (`crates/cowork-providers/src/codex_app_server/`), completely separate from
  Cowork's Windows MXC sandbox.

## Verification

- Unit & Rust integration: `cargo test -p cowork-sandbox -p cowork-server` asserts exact argv / policy text per policy × platform, cached `.git`/`.cowork` discovery, credential read-deny masks, escalate-on-failure detection, and the `__sandbox-exec` CLI (including `--print-command`, which prints the transformed backend launch as one JSON line without executing it).
- **Enforcement (real OS sandbox):** `crates/cowork-sandbox/tests/backends_and_seccomp.rs`,
  `seatbelt_live_macos.rs`, `windows_mxc_live.rs`, and `crates/cowork-server/tests/sandbox_exec_e2e.rs` spawn the
  actual backend and assert allow/deny on a real kernel. Dedicated GitHub Linux x64/ARM64,
  macOS ARM64, and Windows x64/ARM64 jobs run `cargo test -p cowork-sandbox` natively.
  - Linux: production `cowork-server __sandbox-exec` uses native Rust seccomp-BPF (`crates/cowork-sandbox/src/linux_seccomp.rs`) with zero Python runtime dependency; install `bubblewrap` and enable usable user namespaces.
  - Windows: `cargo test -p cowork-sandbox --test windows_mxc_live` verifies live MXC `ProcessContainer` kernel enforcement on PSEC-capable Windows hosts and fail-closed `SANDBOX_REQUIRED` gating on hosts without PSEC. CI runs this natively on both x64 (`windows-latest`) and ARM64 (`windows-11-arm`).
- The Office conversion qualification (`scripts/officeWasmQualification.ts`) runs its
  converter under the Rust sandbox via `cowork-server __sandbox-exec --print-command`
  and only tightens the printed launch (positive Linux mount view, extra Seatbelt denies).
