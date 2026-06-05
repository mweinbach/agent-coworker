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

## Configuration

`config.sandbox` (built-in default in `config/defaults.json`):

```json
{ "sandbox": { "mode": "workspace-write", "network": true } }
```

- `mode`: `auto` | `read-only` | `workspace-write` | `danger-full-access`
- `network`: allow outbound network inside the sandbox (default `true`)
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
  and runs it under `/usr/bin/sandbox-exec`. Pure string/argv generation.
- **Linux — bubblewrap** (`bwrap.ts`): `--ro-bind / /` for reads, `--bind` per
  writable root, `--ro-bind` to re-protect `.git`/`.cowork`, `--unshare-net` when
  network is restricted, plus user/pid namespaces and a fresh `/proc`. Requires
  `bwrap` on `PATH`; if absent the command runs unsandboxed with a logged warning.
  (The in-process seccomp layer Codex adds is not ported — bwrap alone provides
  filesystem + network + namespace isolation.)
- **Windows — restricted token** (`crates/cowork-win-sandbox`): a native helper
  runs the child under a restricted (LUA) token inside a kill-on-close Job
  Object. **Status: the Win32 path requires a Windows CI build to be verified;**
  per-root ACL filesystem scoping and WFP network isolation are tracked TODOs.
  When the helper is absent the command runs unsandboxed with a warning.

## Verification

- Unit: `test/platform/sandbox.test.ts` asserts exact argv per policy × platform
  and the escalate-on-failure detection.
- Linux integration: under `read-only`, `touch $cwd/x` is denied by the OS;
  `workspace-write` permits writing in cwd but not `$HOME`; network off blocks
  `curl`. Skipped + warned when `bwrap`/user namespaces are unavailable.
- macOS / Windows: verified on their own CI runners (this repo's dev container is
  Linux-only).
