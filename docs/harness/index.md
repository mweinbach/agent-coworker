# Harness Docs Index

This directory is the system-of-record for harness engineering in `agent-coworker`.

The harness has two complementary layers:

- the **fast inner loop** (`scripts/run_raw_agent_loops.ts`)
- the **real-boundary session layer** (the WebSocket server/session/runtime path)

Harness context now lives in both worlds: it is persisted session state and also injected into runtime turns as structured task contract data.
Raw-loop strict mode now validates final contracts and artifacts instead of treating tool choreography alone as success.

Long-running Deep Research jobs are intentionally outside the harness/session loop. They use the same auth home and shared SQLite storage, but they run through `ResearchService` instead of `AgentSession` so desktop can expose a global analyst surface without dragging workspace chat state into the execution model.

- `config.md`: harness config precedence, environment variables, and config-file keys.
- `observability.md`: Langfuse-only telemetry wiring and runtime behavior.
- `context.md`: harness context schema and WebSocket interaction flow.
- `slo.md`: historical SLO doc status (query/SLO protocol paths are removed).
- `runbook.md`: operator guide for running harness scenarios and viewing artifacts.

See also:

- `docs/websocket-protocol.md` for the wire-level protocol contract.
- `docs/session-storage-architecture.md` for shared SQLite + research-row persistence.
- `scripts/run_raw_agent_loops.ts` for the harness runner implementation.
