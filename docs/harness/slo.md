# Harness SLO Checks

SLO checks are evaluated against observability queries and summarized as a per-run report.

## Check Schema

`HarnessSloCheck`:

- `id: string`
- `type: "latency" | "error_rate" | "custom"`
- `queryType: "logql" | "promql" | "traceql"`
- `query: string`
- `op: "<" | "<=" | ">" | ">=" | "==" | "!="`
- `threshold: number`
- `windowSec: number`

## Execution

- Query execution: `src/observability/query.ts`
- SLO evaluation: `src/observability/slo.ts`
- WebSocket trigger: client `harness_slo_evaluate`, server `harness_slo_result`

## Report-Only vs Strict

- Report-only (default): checks are recorded but do not fail the harness run.
- Strict mode (`--strict` and not report-only): failed checks fail the run.

Harness artifacts include:

- `slo_checks.json`
- `observability_queries.json`
- `slo_report.json`
