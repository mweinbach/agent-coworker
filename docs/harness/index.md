# Harness Docs Index

This directory is the system-of-record for harness engineering in `agent-coworker`.

The harness has two complementary layers:

- the **fast inner loop** (`scripts/run_raw_agent_loops.ts`)
- the **real-boundary session layer** (the WebSocket server/session/runtime path)

Harness context now lives in both worlds: it is persisted session state and also injected into runtime turns as structured task contract data.

- `config.md`: harness config precedence, environment variables, and config-file keys.
- `observability.md`: Langfuse-only telemetry wiring and runtime behavior.
- `context.md`: harness context schema and WebSocket interaction flow.
- `slo.md`: historical SLO doc status (query/SLO protocol paths are removed).
- `runbook.md`: operator guide for running harness scenarios and viewing artifacts.

See also:

- `docs/websocket-protocol.md` for the wire-level protocol contract.
- `scripts/run_raw_agent_loops.ts` for the harness runner implementation.
