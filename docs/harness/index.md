# Harness Docs Index

This directory is the system-of-record for harness engineering in `agent-coworker`.

- `observability.md`: local observability stack (OTel + Vector + Victoria) and query APIs.
- `context.md`: harness context schema and WebSocket interaction flow.
- `slo.md`: SLO check schema, report-only semantics, and strict mode behavior.
- `runbook.md`: exhaustive operator guide for running, using, viewing, and troubleshooting the full harness stack.
  - Includes the Next.js realtime portal workflow (`apps/portal`).

See also:
- `docs/websocket-protocol.md` for wire-level message/event definitions.
- `scripts/run_raw_agent_loops.ts` for the current harness runner implementation.
