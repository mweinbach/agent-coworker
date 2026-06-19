# Harness Docs Index

This directory is the system-of-record for harness engineering in `agent-coworker`.

The harness has two complementary layers:

- the **fast inner loop** (`packages/harness/src/run_raw_agent_loops.ts`)
- the **real-boundary session layer** (the WebSocket server/session/runtime path)

Harness context now lives in both worlds: it is persisted session state and also injected into runtime turns as structured task contract data.
Raw-loop strict mode now validates final contracts and artifacts instead of treating tool choreography alone as success.

Long-running Deep Research jobs are intentionally outside the harness/session loop. They use the same auth home and shared SQLite storage, but they run through `ResearchService` instead of `AgentSession` so desktop can expose a global analyst surface without dragging workspace chat state into the execution model.

Project Task mode is also distinct from the legacy per-session harness context. It is an explicit user-selected mode beside chat, coordinated by `TaskCoordinator`, persisted as normalized task/work state, and projected into each task-owned session at turn time. Standard chat remains unchanged and task-owned sessions are filtered from normal chat listings. Material questions are durable task records: non-blocking questions carry provisional defaults while work continues, and blocking questions pause at a tool boundary then automatically resume or steer the primary task thread after the final answer. Task artifacts are stable logical outputs with immutable versions in `~/.cowork/artifacts`; the coordinator owns capture, acceptance, restore, focused revision threads, live-file conflict checks, and review-state transitions. Office-aware preview and comparison run in the harness, not the desktop client.

- `config.md`: harness config precedence, environment variables, and config-file keys.
- `observability.md`: Langfuse-only telemetry wiring and runtime behavior.
- `context.md`: harness context schema and WebSocket interaction flow.
- `slo.md`: historical SLO doc status (query/SLO protocol paths are removed).
- `runbook.md`: operator guide for running harness scenarios and viewing artifacts.

See also:

- `docs/sandbox.md` for the OS-level command sandbox (macOS/Linux/Windows) and escalate-on-failure.
- `docs/websocket-protocol.md` for the wire-level protocol contract.
- `docs/session-storage-architecture.md` for shared SQLite + research-row persistence.
- `packages/harness/src/run_raw_agent_loops.ts` for the harness runner implementation.
