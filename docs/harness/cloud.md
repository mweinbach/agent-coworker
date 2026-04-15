# Harness Cloud Deployment

This document captures the current recommended cloud rollout for `agent-coworker`.

## Recommended First Milestone

- target mode: `hosted-single-tenant`
- control-plane host: `fly-machines`
- execution backend: `local`
- first sandbox prototype: `e2b`

This keeps the existing Bun WebSocket server intact while making the future sandbox boundary explicit.

## Control Plane vs Execution Plane

Treat the current server as the **control plane**:

- WebSocket / JSON-RPC session handling
- approvals and asks
- persistence and backups
- provider auth and runtime orchestration

Treat sandboxing as the future **execution plane**:

- `bash`
- `read`
- `write`
- `edit`
- `glob`
- `grep`
- later: `stdio` MCP

## Why Fly Machines First

Fly Machines fit the current architecture because the harness expects a long-lived Bun WebSocket process exposed over `wss`.

Benefits:

- direct fit for `bun run serve`
- durable single-tenant compute
- straightforward TLS/auth fronting
- clean path toward later per-workspace machines if needed

## Why E2B First For Sandboxing

E2B is the first execution-plane prototype because it already maps well to the current tool surface:

- command execution
- filesystem reads/writes
- PTY support
- pause/resume semantics

That makes it a practical first adapter target for the execution backend seam in `src/execution/`.

## Rollout Sequence

1. Host the Bun server on Fly Machines behind TLS/auth.
2. Persist `.cowork`, uploads, outputs, and session state on durable storage.
3. Keep execution backend `local` for the hosted MVP.
4. Move shell/filesystem-heavy tools to a sandbox execution backend.
5. Revisit `stdio` MCP only after the shell/filesystem path is stable.

## Current Product Surface

The hosted-first cloud defaults are exposed through:

- `config/defaults.json`
- `src/config.ts`
- `session_config` workspace control payloads
- `docs/websocket-protocol.md`

These fields are descriptive today; they do not by themselves move execution into a sandbox.
