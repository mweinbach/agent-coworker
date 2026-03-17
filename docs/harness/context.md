# Harness Context

Harness context captures run intent in a structured format that agents can read/write over WebSocket.

## Schema

`HarnessContextPayload`:

- `runId: string`
- `taskId?: string`
- `objective: string`
- `acceptanceCriteria: string[]`
- `constraints: string[]`
- `metadata?: Record<string, string>`

Server stores an `updatedAt` timestamp and returns `HarnessContextState`.

Normalization rules:

- `runId`, `taskId`, and `objective` are trimmed on write
- blank `acceptanceCriteria` and `constraints` entries are removed
- `updatedAt` is assigned by the server

## WebSocket Messages

- Client `harness_context_get` requests the current context for the session.
- Client `harness_context_set` sets/replaces the current context payload.
- Server emits `harness_context` with the updated/current value (or `null`).

## Storage Behavior

- Live context is held in the session-scoped in-memory store [`src/harness/contextStore.ts`](../../src/harness/contextStore.ts).
- `harness_context_set` updates the live store, emits the new `harness_context` event, and queues a persisted session snapshot.
- Session snapshots include `context.harnessContext`, and the SQLite materialized state stores the same payload in `harness_context_json`.
- When a session is resumed from storage, [`AgentSession.ts`](../../src/server/session/AgentSession.ts) seeds the live context store from the persisted snapshot before normal event handling resumes.
- The live in-memory entry is cleared when the session is disposed or closed.
