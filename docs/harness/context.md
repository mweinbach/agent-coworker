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

## WebSocket Messages

- Client `harness_context_get` requests the current context for the session.
- Client `harness_context_set` sets/replaces the current context payload.
- Server emits `harness_context` with the updated/current value (or `null`).

## Storage Behavior

The context store is session-scoped in memory (`src/harness/contextStore.ts`).  
Context is cleared on session dispose.
