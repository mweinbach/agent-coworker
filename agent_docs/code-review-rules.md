# Code Review Rules

Load this file when reviewing diffs. Apply these rules only when the changed code touches the named contract. Report a finding only for a concrete violation introduced by the diff; do not restate a rule as general advice on an otherwise safe change.

## External and persisted contracts

- Search for changes that remove, rename, or reinterpret an existing JSON-RPC method, field, notification, projected item identity, model ID, config key, or persisted value without a compatibility path. These surfaces may have desktop, mobile, CLI, or third-party consumers even when they are marked internal or experimental. Preserve the existing contract, add a backward-compatible extension, or provide an explicit migration; keep schemas, protocol docs, and regression tests aligned.
  - Where to look: `crates/cowork-protocol/src/schemas.rs`, `crates/cowork-protocol/src/ws_jsonrpc_schema.json`, `src/shared/jsonrpcControlSchemas.ts`, `crates/cowork-server/src/`, `docs/websocket-protocol.md`, `config/models/`, `config/defaults.json`

## Authority boundaries

- Search for privileged tools, task/thread operations, filesystem access, or native desktop host operations whose authorization is enforced only by a UI check or after dispatch. Enforce least privilege at the server, tool factory, route, or native boundary before the operation executes, and add a regression covering the disallowed session or caller as well as the allowed path.
  - Where to look: `crates/cowork-tools/src/catalog.rs` (`create_builtin_tools` gating), `crates/cowork-server/src/`, `crates/cowork-desktop/src/native/security.rs`, `crates/cowork-desktop/src/native/path_boundary.rs`
  - Related: `repo-contracts.md` → Thread-tool and H3 permissions

## Harness-owned behavior

- Search for product behavior implemented only in a desktop or mobile client when the capability must also work from the CLI or another UI. Put state, policy, persistence, and agent behavior in the harness/server, expose it through typed JSON-RPC, and keep each UI as a thin adapter. Pure presentation and platform-native window behavior may remain client-specific.
  - Where to look: logic creeping into `crates/cowork-desktop/src/state.rs` or `apps/mobile/` that has no JSON-RPC counterpart in `crates/cowork-server/src/`

## Native host boundaries (desktop)

- Search for UI actions that bypass path confinement, shell-launch validation, or workspace root authorization in the native desktop layer. Validate inputs and filesystem roots inside `crates/cowork-desktop/src/native/` before performing host operations.
  - Where to look: `crates/cowork-desktop/src/native/security.rs`, `crates/cowork-desktop/src/native/path_boundary.rs`, `crates/cowork-desktop/src/native/explorer.rs`, `crates/cowork-desktop/src/native/shell_ops.rs`

## Workspace persistence (desktop)

- Search for new, renamed, or cleared workspace fields that do not round-trip through persistence sanitization and migration. Preserve explicit clear/inherit semantics, mutate the same workspace class the control renders, and add save/reload coverage so a setting cannot appear to work and then silently disappear after restart.
  - Where to look: `crates/cowork-desktop/src/native/persistence.rs`, `crates/cowork-server/src/desktop_state_normalize.rs`
  - Related: `repo-contracts.md` → Workspace settings, Three-tier inherit semantics

## Optimistic message identity (desktop)

- Search for chat send, retry, steer, replay, or projection changes that drop or regenerate `clientMessageId`. Preserve the originating ID through JSON-RPC, server events, projected user items, retries, and reconciliation so an accepted send cannot render duplicate user messages.
  - Where to look: `crates/cowork-server/src/jsonrpc_turn.rs`, `crates/cowork-inference/src/projector.rs`, `crates/cowork-protocol/src/projector.rs`, `crates/cowork-desktop/src/state.rs`
  - Related: `repo-contracts.md` → Optimistic chat sends, JSON-RPC projector
