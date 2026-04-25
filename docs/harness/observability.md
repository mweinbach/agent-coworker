# Harness Observability (Langfuse-Only)

Harness observability uses Langfuse's OpenTelemetry processor/runtime and exports traces to Langfuse.

## Config Resolution

The harness resolves observability from the same layered config path as the rest of `AgentConfig`:

1. Environment variables
2. Project `.cowork/config.json`
3. User `~/.cowork/config/config.json`
4. Built-in `config/defaults.json`

`AGENT_OBSERVABILITY_ENABLED` overrides the top-level `observabilityEnabled` boolean. Langfuse connection fields can come from environment variables or the `observability` config object.

## Runtime Behavior

- Telemetry is controlled by `AGENT_OBSERVABILITY_ENABLED`.
- When enabled with valid Langfuse credentials, the runtime initializes `LangfuseSpanProcessor` and exports spans to:
  - `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`
- `otelEndpoint` is derived from the resolved base URL; it is not configured independently.
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

Equivalent config-file keys:

- `observabilityEnabled`
- `observability.baseUrl`
- `observability.publicKey`
- `observability.secretKey`
- `observability.tracingEnvironment`
- `observability.release`

## Harness Runner Emissions

`packages/harness/src/run_raw_agent_loops.ts` emits lifecycle events:

- `harness.run.started`
- `harness.run.completed`
- `harness.run.failed`

Run metadata (`run_meta.json`) includes `observabilityEnabled` plus an `observability` summary with `startHealth` and `endHealth` snapshots.

The WebSocket-facing runtime status is documented separately in [`docs/websocket-protocol.md`](../websocket-protocol.md) under `observability_status`.
