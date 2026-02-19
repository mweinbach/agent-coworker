# Harness Observability (Langfuse-Only)

Harness observability exports OTLP traces directly to Langfuse.

## Runtime Behavior

- Telemetry is controlled by `AGENT_OBSERVABILITY_ENABLED`.
- When enabled with valid Langfuse credentials, span events are exported to:
  - `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`
- When telemetry is enabled but credentials are missing/misconfigured, the runtime emits a one-time warning and continues without failing turns/runs.

## Environment Variables

- `AGENT_OBSERVABILITY_ENABLED` (`true|false`)
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (defaults to `https://cloud.langfuse.com`)
- `LANGFUSE_TRACING_ENVIRONMENT`
- `LANGFUSE_RELEASE`

## Harness Runner Emissions

`scripts/run_raw_agent_loops.ts` emits lightweight lifecycle events:

- `harness.run.started`
- `harness.run.completed`
- `harness.run.failed`

Emitted metadata is intentionally limited to balanced identifiers (for example run/session/provider/model/tool identifiers) and avoids raw prompt/tool payload bodies.
