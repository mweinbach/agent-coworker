# Harness Observability (Langfuse-Only)

Harness observability uses Langfuse's OpenTelemetry processor/runtime and exports traces to Langfuse.

## Local Server File Logs

Independent of Langfuse telemetry, the server writes session `log` and `error` events to
`~/.cowork/logs/server-YYYY-MM-DD.log` (JSONL, one file per UTC day). This is on by default in every
build — packaged desktop builds have no terminal, so this file is the durable record of harness tool
traces and turn failures. Entries pass through the shared diagnostics redaction
(`src/diagnostics/redaction.ts`) before hitting disk, files are `0600`, and files older than 14 days
are swept automatically. Set `COWORK_SERVER_FILE_LOGS=0` to disable. Terminal mirroring via
`COWORK_HARNESS_TERMINAL_LOGS=1` is unchanged and independent.

The server also runs best-effort startup maintenance (`src/server/runtime/startupMaintenance.ts`):
stale `running`/`pending_init` execution states are reconciled to `errored` before any turn can
start, model stream chunks for sessions untouched for 30 days are pruned, leaked session snapshot
temp files are swept, and session-backup roots are pruned (closed-session retention plus aging out
orphaned, corrupt, abandoned-active, and leaked staging directories).

## Config Resolution

The harness resolves observability from the same layered config path as the rest of `AgentConfig`:

1. Environment variables
2. Project `.cowork/config.json`
3. User `~/.cowork/config/config.json`
4. Built-in `config/defaults.json`

`AGENT_OBSERVABILITY_ENABLED` overrides the top-level `observabilityEnabled` boolean. Langfuse connection fields can come from environment variables or the `observability` config object.

Public/default packaged builds keep `observabilityEnabled` off unless the desktop Privacy & Telemetry setting explicitly enables AI trace diagnostics. Source/dev harness runs can opt in with `AGENT_OBSERVABILITY_ENABLED=true` plus Langfuse credentials.

## Runtime Behavior

- Telemetry is controlled by `AGENT_OBSERVABILITY_ENABLED`.
- When enabled with valid Langfuse credentials, the runtime initializes `LangfuseSpanProcessor` and exports spans to:
  - `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`
- `otelEndpoint` is derived from the resolved base URL; it is not configured independently.
- Runtime model calls are metadata-only by default: spans include model/provider/usage/timing metadata, but `recordInputs=false` and `recordOutputs=false`.
- Full LLM I/O capture is only enabled when `recordInputs` and/or `recordOutputs` are explicitly true through env/config. In the desktop app, this only happens when the user enables both AI trace diagnostics and the full-payload toggle.
- Metadata-only spans redact payload-like attributes such as prompts, responses, commands, stdout/stderr, transcripts, file paths, and uploaded file names. Secret-like attributes are always redacted.
- When telemetry is enabled but credentials are missing/misconfigured, the runtime degrades observability health, emits warnings, and continues without failing turns/runs.
- Runtime/export failures are non-fatal and surfaced via observability health status.

## Environment Variables

- `AGENT_OBSERVABILITY_ENABLED` (`true|false`, defaults to `false`)
- `AGENT_OBSERVABILITY_RECORD_INPUTS` (`true|false`, defaults to `false`)
- `AGENT_OBSERVABILITY_RECORD_OUTPUTS` (`true|false`, defaults to `false`)
- `AGENT_OBSERVABILITY_RECORD_PAYLOADS` (`true|false`, shorthand for both inputs and outputs unless a specific flag overrides it)
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
- `observability.recordInputs`
- `observability.recordOutputs`

Example source/dev opt-in:

```sh
export AGENT_OBSERVABILITY_ENABLED=true
export AGENT_OBSERVABILITY_RECORD_PAYLOADS=false
export LANGFUSE_PUBLIC_KEY=...
export LANGFUSE_SECRET_KEY=...
```

Set `AGENT_OBSERVABILITY_RECORD_PAYLOADS=true` only for runs where prompt/response capture is intentional.

## Harness Runner Emissions

`packages/harness/src/run_raw_agent_loops.ts` emits lifecycle events:

- `harness.run.started`
- `harness.run.completed`
- `harness.run.failed`

Run metadata (`run_meta.json`) includes `observabilityEnabled` plus an `observability` summary with `startHealth` and `endHealth` snapshots.

The WebSocket-facing runtime status is documented separately in [`docs/websocket-protocol.md`](../websocket-protocol.md) under `observability_status`.
