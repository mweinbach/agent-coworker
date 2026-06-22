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
src/platform/sandbox/
  policy.ts     SandboxPolicy + resolution from role/config + writable roots
  index.ts      SandboxManager.transform({file,args,policy,cwd}) -> wrapped {file,args,env}
  seatbelt.ts   macOS: /usr/bin/sandbox-exec -p <.sbpl> -D... -- <cmd>
  bwrap.ts      Linux: bwrap <mounts> --unshare-net? -- <cmd>
  windows.ts    Windows: cowork-win-sandbox.exe run --mode ... -- <cmd>
  detect.ts     capability and integrity probes (sandbox-exec / bwrap / helper bundle)
  denied.ts     isLikelySandboxDenied(output) for escalate-on-failure
crates/cowork-win-sandbox/   Windows setup, sandbox, and command-runner helpers
```

`SandboxManager.transform()` is the single abstraction every platform flows
through. Given the command argv and a policy it selects a backend
(`macos-seatbelt` | `linux-bwrap` | `windows-sandbox` | `none`) and prepends
the appropriate wrapper, mirroring Codex's `SandboxManager::transform`. The bash
tool (`src/tools/bash.ts`) is the single integration point: it wraps the shell
candidate before spawning and attaches marker env vars (`COWORK_SANDBOX`,
`COWORK_SANDBOX_NETWORK_DISABLED`) to the child.

## Policy model

`SandboxPolicy` (`policy.ts`), adopted from Codex:

| Policy | Filesystem | Network |
|--------|-----------|---------|
| `read-only` | full disk read, no writes | per `network` |
| `no-project-write` | full disk read; temp scratch writable; no project writable roots | per `network` |
| `workspace-write` | full read; writes limited to `writableRoots` (cwd, output dir, Cowork tool runtime caches, child `targetPaths`) + temp; `.git`/`.cowork` stay read-only | per `network` |
| `danger-full-access` | unrestricted (no sandbox) | unrestricted |

The policy is resolved per turn in `src/agent.ts` from the agent role and config:
read-only roles (`explorer`, `research`, `reviewer`) → `no-project-write` so
verifier tooling can use temp files without mutating the workspace; write-capable
roles → `workspace-write`. Explicit `sandbox.mode: "read-only"` stays fully
immutable. Child-agent `targetPaths` become the writable roots, so write scope is
enforced by the OS rather than by parsing the command.

Reads are full-disk in every sandboxed mode, so global skills/plugins/config
under `~/.cowork` (e.g. `~/.cowork/skills`, `~/.cowork/plugins`), built-in/bundled
skill assets, and any skill/plugin scripts the agent runs via `bash` remain
readable and runnable inside the sandbox — they are just read-only (writes there
are denied, as `~/.cowork` lives outside the writable roots and `.cowork` is
protected metadata). The built-in `read`/`glob`/`grep` tools mirror this:
`readRoots` (`src/utils/permissions.ts`) includes `config.skillsDirs`,
`config.workspacePluginsDir`/`config.userPluginsDir`, and every discovered plugin
root + its declared skill paths (`pluginReadRoots`), and reads outside the project
are not constrained by a scoped child's `targetPaths`, so scoped agents can still
load global skills and plugins.

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
name looks file-like (for example `docs/v1.0/`), keep the trailing slash so Linux
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
(`denied.ts:isLikelySandboxDenied` — "operation not permitted", "read-only file
system", "seccomp"/"landlock", etc.), the bash tool asks the user (via the
`approval` event, reason `sandbox_denied_escalation`) whether to re-run it with
`danger-full-access`. Unsandboxed fallback because a backend is unavailable uses
the same protected sandbox-denial approval path, since it also grants full
filesystem access. This mirrors Codex's `with_escalated_permissions` flow.

## Per-platform backends

- **macOS — Seatbelt** (`seatbelt.ts`): generates a `.sbpl` profile (deny-by-default
  base + dynamic `file-read*`/`file-write*`/network sections, `-D` path params)
  and runs it under `/usr/bin/sandbox-exec`. Pure string/argv generation. Protected
  metadata (`.git`/`.cowork`) is excluded per writable root via `-D` subpath
  params (so the exclusion is relative to the root — a workspace that merely lives
  under a `.cowork` ancestor, e.g. `~/.cowork/chats/<id>`, is not wrongly denied):
  the direct `.git`/`.cowork` children plus any existing nested ones, matching the
  bwrap backend.
- **Linux — bubblewrap** (`bwrap.ts`): `--ro-bind / /` for reads, `--bind` per
  writable root, `--ro-bind` to re-protect `.git`/`.cowork`, `--unshare-net` when
  network is restricted, plus user/pid namespaces and a fresh `/proc`. `bwrap` is
  resolved only from trusted system dirs (`/usr/bin`, `/bin`, …) or an absolute
  `COWORK_BWRAP_PATH` — never `$PATH` — so a workspace-planted binary can't hijack
  it. If absent the default `sandbox.requireBackend: false` surfaces an
  unsandboxed fallback approval for unscoped workspace-write commands; set
  `sandbox.requireBackend: true` to fail closed instead.
  (The in-process seccomp layer Codex adds is not ported — bwrap alone provides
  filesystem + network + namespace isolation.)
  **Limitation:** the `.git`/`.cowork` re-protection is bind-based. It re-freezes
  metadata directories that already exist under explicit writable roots, including
  nested submodule/worktree metadata, but it does not fabricate missing metadata
  mountpoints because doing so can create host directories during sandbox setup.
  Prefer narrow `targetPaths` when a child must not create new metadata paths.
- **Windows — capability ACLs + WFP** (`crates/cowork-win-sandbox`): the runner is
  pinned to the OpenAI Codex Windows sandbox implementation. A one-time elevated
  `setup` provisions dedicated online/offline identities, capability-SID ACLs,
  WFP network rules, and versioned readiness state. `run` launches the child with
  the appropriate restricted token inside a kill-on-close Job Object. Writable
  roots are limited to the resolved workspace/`targetPaths` plus TEMP/TMP;
  protected `.git`, `.agents`, `.codex`, and `.cowork` roots are denied. The
  native `probe` must demonstrate workspace and temp writes, outside/metadata/
  junction/child escape denial, and network denial before the server reports
  filesystem, network, process, and integrity enforcement.

  Desktop resources contain `cowork-win-sandbox.exe`,
  `codex-windows-sandbox-setup.exe`, `codex-command-runner.exe`, and a SHA-256
  manifest. Development rebuilds the bundle and passes absolute paths plus all
  three hashes to the source server. Packaged builds additionally require valid
  Authenticode signatures; the release workflow refuses unsigned Windows
  artifacts. A missing helper, hash/signature mismatch, cancelled UAC prompt, or
  failed/stale probe leaves restricted commands fail-closed and records repair
  diagnostics. Only the setup/health path runs automatically in that state;
  free-form shell execution still requires the explicit sandbox-escape approval
  where policy permits it.

## Verification

- Unit: `test/platform/sandbox.test.ts` asserts exact argv / policy text per
  policy × platform and the escalate-on-failure detection.
- **Enforcement (real OS sandbox):** `test/platform/sandbox.enforcement.integration.test.ts`
  spawns the actual backend and asserts allow/deny on a real kernel — in-workspace
  writes allowed, `.git`/`.cowork` (incl. nested, on macOS) denied, out-of-workspace
  writes denied, reads allowed, and child `targetPaths` scoping. It is gated by
  platform + backend availability, so it **skips** on the Linux CI image (no
  `bwrap`/user namespaces). Run it before merging:
  - macOS: `bun test test/platform/sandbox.enforcement.integration.test.ts`
  - Linux (bubblewrap host): same command (auto-detects `bwrap`).
  - Windows: build all helpers (`cargo build --release --bins --manifest-path
    crates/cowork-win-sandbox/Cargo.toml`), set the three absolute
    `COWORK_WIN_SANDBOX_*` paths and SHA-256 values, opt in with
    `RUN_WINDOWS_SANDBOX_INTEGRATION=1`, and run the same command after one-time
    setup. CI runs this suite natively on both x64 (`windows-latest`) and ARM64
    (`windows-11-arm`).
