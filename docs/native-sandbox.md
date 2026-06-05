# Native sandbox

Cowork shell commands use a platform sandbox as the enforcement boundary. User approvals decide
whether a command may run; they are not the filesystem isolation mechanism.

Reference implementation: `openai/codex` at
`4de7a2b9d8eae19e00ca7f744647fa1aabdc204f`.

## Modes

- `read-only`: filesystem reads are allowed, writes are denied.
- `workspace-write`: reads are allowed, writes are limited to workspace roots and child-agent
  `targetPaths` when present.
- `danger-full-access`: disables platform sandboxing and is only selected for yolo sessions.

Network access is restricted for non-yolo modes. Linux currently enforces filesystem isolation
with the Cowork Landlock helper; stricter network enforcement is represented in the policy so the
backend can be swapped without changing the tool contract.

## Platform backends

- Linux: `native/sandbox/cowork-linux-sandbox.c`, compiled by `bun run build:sandbox-helpers`.
- macOS: Seatbelt profile generation with pinned `/usr/bin/sandbox-exec`.
- Windows: explicit restricted-token helper hook via `COWORK_WINDOWS_SANDBOX_HELPER`; missing
  helper fails closed.

## Command flow

1. `src/tools/bash.ts` builds a shell execution plan.
2. `src/sandbox/policy.ts` maps session state to a sandbox policy.
3. `src/sandbox/native.ts` transforms the command into the platform sandbox invocation.
4. The existing shell output, timeout, abort, and approval flow remains in the bash tool.
