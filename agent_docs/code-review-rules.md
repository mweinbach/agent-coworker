# Code Review Rules

Load this file when reviewing diffs. Apply these rules only when the changed code touches the named contract. Report a finding only for a concrete violation introduced by the diff; do not restate a rule as general advice on an otherwise safe change.

## External and persisted contracts

- Search for changes that remove, rename, or reinterpret an existing JSON-RPC method, field, notification, projected item identity, model ID, config key, or persisted value without a compatibility path. These surfaces may have desktop, mobile, CLI, or third-party consumers even when they are marked internal or experimental. Preserve the existing contract, add a backward-compatible extension, or provide an explicit migration; keep schemas, protocol docs, and regression tests aligned.
  - Where to look: `src/server/jsonrpc/schema*.ts`, `src/server/jsonrpc/routes/`, `docs/websocket-protocol.md`, `config/models/`, `config/defaults.json`

## Authority boundaries

- Search for privileged tools, task/thread operations, filesystem access, or Electron IPC whose authorization is enforced only by a UI/client check or after dispatch. Enforce least privilege at the server, tool factory, route, or IPC boundary before the operation executes, and add a regression covering the disallowed session or sender as well as the allowed path.
  - Where to look: `src/tools/index.ts` (`createTools` gating), `src/server/jsonrpc/routes/`, `apps/desktop/electron/ipc.ts`
  - Related: `repo-contracts.md` → Thread-tool and H3 permissions

## Harness-owned behavior

- Search for product behavior implemented only in a desktop or mobile client when the capability must also work from the CLI or another UI. Put state, policy, persistence, and agent behavior in the harness/server, expose it through typed JSON-RPC, and keep each UI as a thin adapter. Pure presentation and platform-native window behavior may remain client-specific.
  - Where to look: logic creeping into `apps/desktop/src/app/store.ts` or `apps/mobile/` that has no JSON-RPC counterpart in `src/server/jsonrpc/routes/`

## Privileged IPC (desktop)

- Search for a renderer capability that bypasses the typed preload bridge, or an IPC contract changed in only part of the call chain. Keep the channel and payload types, preload exposure, main-process handler, and renderer wrapper in sync. Validate the sender and inputs in the main process; never expose an unrestricted Node or filesystem primitive to the renderer.
  - Where to look (all four must change together): `apps/desktop/src/lib/desktopApi.ts` → `apps/desktop/electron/preload.ts` → `apps/desktop/electron/ipc.ts` → `apps/desktop/src/lib/desktopCommands.ts`

## Workspace persistence (desktop)

- Search for new, renamed, or cleared workspace fields that do not round-trip through persistence sanitization and migration. Preserve explicit clear/inherit semantics, mutate the same workspace class the control renders, and add save/reload coverage so a setting cannot appear to work and then silently disappear after restart.
  - Where to look: `apps/desktop/electron/services/persistence.ts` (`sanitizeWorkspaces`)
  - Related: `repo-contracts.md` → Workspace settings, Three-tier inherit semantics

## Optimistic message identity (desktop)

- Search for chat send, retry, steer, replay, or projection changes that drop or regenerate `clientMessageId`. Preserve the originating ID through JSON-RPC, server events, projected user items, retries, and reconciliation so an accepted send cannot render duplicate user messages.
  - Where to look: `src/server/jsonrpc/routes/turn.ts`, `src/server/jsonrpc/notificationProjector.ts`, `apps/desktop/src/app/store.ts`
  - Related: `repo-contracts.md` → Optimistic chat sends, JSON-RPC projector
