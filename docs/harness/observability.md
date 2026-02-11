# Harness Observability

The harness uses a local Docker Compose stack per run/worktree:

- OpenTelemetry OTLP/HTTP ingest (Vector source)
- Vector fan-out pipeline
- VictoriaLogs query API (`logql`)
- VictoriaMetrics query API (`promql`)
- VictoriaTraces query API (`traceql`)

Notes on trace querying:

- `queryType: "traceql"` first tries `/select/traceql/query`.
- For VictoriaTraces builds that expose trace search via LogsQL (`/select/logsql/query`), harness query code automatically falls back to that endpoint.
- In practice, this means `observability_query` with `queryType: "traceql"` still works across endpoint variants.

## Lifecycle

- Stack config: `config/observability/docker-compose.yml`
- Vector routing: `config/observability/vector/vector.toml`
- Runtime control: `src/observability/runtime.ts`
- CLI helper: `scripts/observability_stack.ts`

The primary harness runner (`scripts/run_raw_agent_loops.ts`) boots and tears down the stack per run when `--observability` is enabled.

## Endpoint Injection

When observability is enabled, the harness injects:

- `AGENT_OBSERVABILITY_ENABLED=true`
- `AGENT_OBS_OTLP_HTTP=<vector otlp endpoint>`
- `AGENT_OBS_LOGS_URL=<victoria logs base url>`
- `AGENT_OBS_METRICS_URL=<victoria metrics base url>`
- `AGENT_OBS_TRACES_URL=<victoria traces base url>`

Run-level endpoint details are written to `observability_endpoints.json` inside each run directory.
