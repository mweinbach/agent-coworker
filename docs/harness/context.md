# Harness Context

Harness context captures structured run intent that the server owns, persists, and injects into runtime turns.

The key distinction is:

- **memory** is long-lived knowledge
- **harness context** is the active task contract for the current session/run

Harness context is session-scoped state. It is not chat history, and it does not override higher-priority system policy, safety rules, or tool-approval requirements.

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

## Runtime Injection Behavior

- The turn runtime reads the current live harness context at turn/pass invocation time from the session-owned store.
- The current context is rendered into the runtime system prompt as a compact **Active Harness Context** section.
- Because the context is read at invocation time, multi-pass turns continue to see the latest contract instead of only a one-time startup snapshot.
- The rendered section explicitly frames the data as a task contract and reminds the model that it does **not** override safety/tool policy.

## Child-Agent Behavior

- Child sessions inherit parent context through explicit spawn context modes instead of a single coarse fork flag.
- `contextMode: "full"` keeps the existing `AgentSession.buildForkContextSeed()` behavior and carries transcript, todos, and harness context together.
- `contextMode: "brief"` injects a synthetic `Parent briefing:` user seed message and can optionally carry harness context and todos.
- `contextMode: "none"` skips transcript cloning and only carries structured context when explicitly requested.
- Deprecated `forkContext` still maps to `contextMode: "full"` / `"none"` for compatibility.
- The child sees inherited harness context in its runtime prompt path, but the context is **not** duplicated into transcript messages.

## Raw-Loop Behavior

- Raw-loop runs can also carry structured harness context.
- The raw-loop runner persists the resolved context to `harness_context.json` inside each run directory.
- Raw-loop delegated child agents preserve harness context when the run forks context into the child delegate.
