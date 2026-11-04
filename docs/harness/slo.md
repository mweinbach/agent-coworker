# Harness SLO Checks

Query-driven SLO evaluation is retired in the current protocol/runtime.

Removed surfaces:

- Client message: `harness_slo_evaluate`
- Server event: `harness_slo_result`
- Legacy TypeScript SLO evaluator modules (removed during the Rust core cutover)

Harness runs continue to produce core run artifacts (`trace.json`, `attempts.json`, `run_meta.json`, `artifacts_index.json`) without query/SLO artifacts.
