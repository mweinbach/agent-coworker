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
  windows.ts    Windows: cowork-win-sandbox.exe --mode ... -- <cmd>
  detect.ts     capability probes (sandbox-exec / bwrap / helper)
  denied.ts     isLikelySandboxDenied(output) for escalate-on-failure
crates/cowork-win-sandbox/   Windows native helper (restricted token + Job Object)
```

`SandboxManager.transform()` is the single abstraction every platform flows
through. Given the command argv and a policy it selects a backend
(`macos-seatbelt` | `linux-bwrap` | `windows-restricted` | `none`) and prepends
the appropriate wrapper, mirroring Codex's `SandboxManager::transform`. The bash
tool (`src/tools/bash.ts`) is the single integration point: it wraps the shell
candidate before spawning and attaches marker env vars (`COWORK_SANDBOX`,
`COWORK_SANDBOX_NETWORK_DISABLED`) to the child.

## Policy model

`SandboxPolicy` (`policy.ts`), adopted from Codex:

| Policy | Filesystem | Network |
|--------|-----------|---------|
| `read-only` | full disk read, no writes | per `network` |
| `workspace-write` | full read; writes limited to `writableRoots` (cwd, output dir, child `targetPaths`) + temp; `.git`/`.cowork` stay read-only | per `network` |
| `danger-full-access` | unrestricted (no sandbox) | unrestricted |

The policy is resolved per turn in `src/agent.ts` from the agent role and config:
read-only roles (`explorer`, `research`, `reviewer`) → `read-only`; write-capable
roles → `workspace-write`. Child-agent `targetPaths` become the writable roots,
so write scope is enforced by the OS rather than by parsing the command.

`targetPaths` are clamped to the workspace: entries that resolve outside it (e.g.
an absolute `/home/user/.ssh`) or inside protected metadata (`.git`/`.cowork`) are
dropped so they never become shell-writable. A spawn whose `targetPaths` all drop
out is rejected up front with a clear error rather than running a child that can
write nowhere useful.

## Configuration

`config.sandbox` (built-in default in `config/defaults.json`):

```json
{ "sandbox": { "mode": "workspace-write", "network": true, "requireBackend": true } }
```

- `mode`: `auto` | `read-only` | `workspace-write` | `danger-full-access`
- `network`: allow outbound network inside the sandbox (default `true`)
- `requireBackend`: fail closed when the selected OS sandbox backend is unavailable
  (default `true`; set `false` to fall back to an unsandboxed run — which still
  prompts for approval in a non-YOLO session, then surfaces a warning)
- env override: `AGENT_SANDBOX=<mode>`

## Escalate-on-failure

There is no pre-run command prompt. Commands run inside the sandbox silently. If
a sandboxed command fails in a way that looks like a sandbox denial
(`denied.ts:isLikelySandboxDenied` — "operation not permitted", "read-only file
system", "seccomp"/"landlock", etc.), the bash tool asks the user (via the
`approval` event, reason `sandbox_denied_escalation`) whether to re-run it with
`danger-full-access`. YOLO mode auto-approves. This mirrors Codex's
`with_escalated_permissions` flow.

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
  it. If absent the command fails closed by default, or runs unsandboxed with a
  surfaced warning when `sandbox.requireBackend` is explicitly `false`.
  (The in-process seccomp layer Codex adds is not ported — bwrap alone provides
  filesystem + network + namespace isolation.)
  **Limitation:** the `.git`/`.cowork` re-protection is bind-based, so it masks
  only the **top-level** metadata under each writable root; nested metadata
  (e.g. a submodule's `/repo/src/.git`) is not re-frozen because per-command
  recursive enumeration is impractical. Prefer narrow `targetPaths` when a child
  must not touch nested metadata; the macOS backend excludes it recursively.
- **Windows — restricted token** (`crates/cowork-win-sandbox`): a native helper
  runs the child under a restricted (LUA) token inside a kill-on-close Job
  Object. It IS selected as the backend (so commands run rather than failing
  closed), providing **process containment only** — per-root ACL filesystem
  scoping and WFP network isolation are tracked TODOs, so workspace-write /
  read-only path scoping is **not** enforced yet. The degradation is surfaced as
  a `[sandbox] …` warning on every Windows command. **Status: the Win32 path
  still requires a Windows CI build to verify enforcement once implemented.**

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
  - Windows: build the helper (`cargo build --release` in `crates/cowork-win-sandbox`),
    then point `COWORK_WIN_SANDBOX_PATH` at the `.exe` (or use the default
    `target/release` path) and run the same command.
