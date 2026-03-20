# Harness Runbook

This runbook covers the raw harness runner in [`scripts/run_raw_agent_loops.ts`](../../scripts/run_raw_agent_loops.ts) and the default `bun run harness:run` entrypoint.

## Prerequisites

- Bun installed
- Provider API key(s) for the providers exercised by the selected runs
- Optional: Langfuse credentials if you want telemetry exports

The runner validates required provider credentials before starting any runs and exits early if a selected scenario needs a missing API key.

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

## Command Reference

- `bun run harness:run`
  - Equivalent to `bun scripts/run_raw_agent_loops.ts --report-only`
  - Uses the default `mixed` scenario
- `bun scripts/run_raw_agent_loops.ts --scenario <name>`
  - Selects one of the supported scenarios
- `bun scripts/run_raw_agent_loops.ts --only-run <run-id>`
  - Repeatable filter; keeps only the named run IDs within the selected scenario
- `bun scripts/run_raw_agent_loops.ts --only-model <model>`
  - Repeatable filter; keeps only the named model IDs within the selected scenario
- `bun scripts/run_raw_agent_loops.ts --report-only`
  - Sets the harness config flag carried into run metadata; current raw-loop invocations already default to this mode
- `bun scripts/run_raw_agent_loops.ts --help`
  - Prints the accepted flags and scenario names

## Scenarios

- `mixed`
- `dcf-model-matrix`
- `gpt-skill-reliability`
- `google-customtools-tool-coverage`
- `codex-gpt-5.4-smoke`

Examples:

```bash
bun run harness:run
bun scripts/run_raw_agent_loops.ts --scenario mixed
bun scripts/run_raw_agent_loops.ts --scenario dcf-model-matrix
bun scripts/run_raw_agent_loops.ts --scenario gpt-skill-reliability
bun scripts/run_raw_agent_loops.ts --scenario google-customtools-tool-coverage
bun scripts/run_raw_agent_loops.ts --scenario codex-gpt-5.4-smoke
bun scripts/run_raw_agent_loops.ts --scenario mixed --only-run claude-spreadsheet --only-run gpt-research
bun scripts/run_raw_agent_loops.ts --scenario mixed --only-model gpt-5.2
```

## Output Layout

Each invocation writes a run root to:

- `<outputDirectory>/<prefix>_<timestamp>` when `outputDirectory` is configured
- `tmp/<prefix>_<timestamp>` relative to the repo when it is not configured

The prefix is scenario-specific:

- `raw-agent-loop_mixed`
- `raw-agent-loop_dcf-model-matrix`
- `raw-agent-loop_gpt-skill-reliability`
- `raw-agent-loop_google-customtools-tool-coverage`
- `raw-agent-loop_codex-gpt-5.4-smoke`

Run-root artifacts:

- `manifest.json`
  - Selected scenario, filters, masked API-key presence, and run inventory
- `anthropic_models_raw.json`
  - Present when Anthropic runs are selected and model discovery succeeds
- `anthropic_models_raw_error.txt`
  - Present when Anthropic model discovery fails

Per-run artifacts:

- `trace.json`
- `trace_attempt-*.json`
- `attempts.json`
- `harness_context.json`
- `tool-log.txt`
- `final.txt`
- `final_reasoning.txt`
- `response_messages.json`
- `run_meta.json`
- `artifacts_index.json`
- `prompt.txt`
- `system.txt`
- `input_messages.json`

`harness_context.json` records the structured run intent injected into the raw-loop turn prompt path. `run_meta.json` includes resolved model metadata plus observability health snapshots at start and end of the run. `artifacts_index.json` hashes the files produced inside the run directory.

## Runtime Notes

- Raw-loop runs set `AGENT_WORKING_DIR` to the repo root for config loading, then set each individual run's `workingDirectory` to its run directory.
- Built-in skills are disabled by default for raw-loop runs unless `COWORK_DISABLE_BUILTIN_SKILLS` is explicitly overridden in the environment.
- Anthropic runs resolve model aliases against the live Anthropic models endpoint and persist the raw response in the run root for traceability.
- Per-run failures are retried with backoff. If all attempts fail, the runner exits non-zero after writing the attempt traces and final metadata.

## Validation Gates

For docs-only changes, run:

```bash
bun run docs:check
```

For harness or protocol behavior changes, run:

```bash
bun test
bun run docs:check
```
