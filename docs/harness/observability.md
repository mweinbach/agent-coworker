# Harness Observability (Langfuse-Only)

Harness observability uses Langfuse's OpenTelemetry processor/runtime and exports traces to Langfuse.

## Runtime Behavior

- Telemetry is controlled by `AGENT_OBSERVABILITY_ENABLED`.
- When enabled with valid Langfuse credentials, the runtime initializes `LangfuseSpanProcessor` and exports spans to:
  - `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`
- Runtime model calls are traced with `recordInputs=true` and `recordOutputs=true` (full LLM I/O) whenever observability is enabled and healthy.
- When telemetry is enabled but credentials are missing/misconfigured, the runtime degrades observability health, emits warnings, and continues without failing turns/runs.
- Runtime/export failures are non-fatal and surfaced via observability health status.

## Environment Variables

- `AGENT_OBSERVABILITY_ENABLED` (`true|false`, defaults to `true`)
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL` (defaults to `https://cloud.langfuse.com`)
- `LANGFUSE_TRACING_ENVIRONMENT`
- `LANGFUSE_RELEASE`

## Harness Runner Emissions

`scripts/run_raw_agent_loops.ts` emits lifecycle events:

- `harness.run.started`
- `harness.run.completed`
- `harness.run.failed`

Run metadata (`run_meta.json`) includes `observabilityEnabled` plus an `observability` summary with `startHealth` and `endHealth` snapshots.
