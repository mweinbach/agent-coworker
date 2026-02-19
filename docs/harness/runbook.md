# Harness Runbook

## Prerequisites

- Bun installed
- Provider API key(s) for the models you plan to run
- Optional: Langfuse credentials if you want telemetry exports

## Configure Optional Langfuse Telemetry

```bash
export AGENT_OBSERVABILITY_ENABLED=true
export LANGFUSE_PUBLIC_KEY=...
export LANGFUSE_SECRET_KEY=...
# optional:
export LANGFUSE_BASE_URL=https://cloud.langfuse.com
export LANGFUSE_TRACING_ENVIRONMENT=dev
export LANGFUSE_RELEASE=$(git rev-parse --short HEAD)
```

If telemetry is enabled but credentials are missing, runs continue and emit a warning.

## Run Harness Scenarios

Default scenario:

```bash
bun run harness:run
```

Explicit scenario selection:

```bash
bun scripts/run_raw_agent_loops.ts --scenario mixed
bun scripts/run_raw_agent_loops.ts --scenario dcf-model-matrix
bun scripts/run_raw_agent_loops.ts --scenario gpt-skill-reliability
```

## Output Layout

Each invocation writes a run root under `output/` and run artifacts per run directory, including:

- `trace.json`
- `trace_attempt-*.json`
- `attempts.json`
- `final.txt`
- `response_messages.json`
- `run_meta.json`
- `artifacts_index.json`

## Portal

Start the portal:

```bash
bun run portal:dev
```

The portal renders run catalog, run detail, attempts, trace summary, outputs, and artifact index.

## Validation Gates

Before merging large harness/protocol changes, run:

```bash
bun test
bun run docs:check
bun run portal:build
```
