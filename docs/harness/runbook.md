# Harness Runbook (Verbose)

This is the deep operational guide for the harness stack in `agent-coworker`.

It is intentionally long and explicit. Use it when you want to:

- bring up observability locally;
- run harness smoke checks and full harness loops;
- operate harness controls from Desktop and TUI clients;
- inspect traces/artifacts/SLO reports after runs;
- debug failures quickly without guessing.

If you only need the short map, see `docs/harness/index.md`.

## 1. What "Harness" Means In This Repo

In this repository, "harness" means the combined system of:

- session-level context controls (`harness_context_get`, `harness_context_set`);
- observability querying (`observability_query`);
- SLO evaluation (`harness_slo_evaluate`);
- local observability infrastructure (Docker Compose with Vector + Victoria services);
- runner scripts that execute model-driven tasks and write reproducible artifacts.

Core references:

- Protocol: `src/server/protocol.ts`
- Server handlers: `src/server/startServer.ts`, `src/server/session.ts`
- Context store: `src/harness/contextStore.ts`
- Query engine: `src/observability/query.ts`
- SLO evaluator: `src/observability/slo.ts`
- Stack runtime: `src/observability/runtime.ts`
- Stack helper CLI: `scripts/observability_stack.ts`
- Smoke runner: `scripts/harness_smoke.ts`
- Full runner: `scripts/run_raw_agent_loops.ts`
- Wire docs: `docs/websocket-protocol.md`

## 2. Fast Start (Minimal Commands)

From repo root:

```bash
bun install
bun run docs:check
bun test
bun run harness:smoke
```

If all four pass, your harness setup is healthy.

## 3. Prerequisites And Preflight

### 3.1 Required tools

- Bun
- Docker Desktop (or Docker Engine with `docker compose`)

Verify:

```bash
bun --version
docker version
docker compose version
```

### 3.2 Provider auth for model-backed runs

`harness:smoke` does not require provider keys.

`harness:run` **does** require all of these in environment:

- `GOOGLE_GENERATIVE_AI_API_KEY` (or `GEMINI_API_KEY`)
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

`scripts/run_raw_agent_loops.ts` fails early if any are missing.

### 3.3 Optional auth path via saved connections

Desktop/TUI normal chat usage can also use `~/.cowork/auth/connections.json` entries (API key or OAuth modes), but full harness loop script still enforces env key presence.

## 4. Operational Modes

There are three practical modes.

### 4.1 Mode A: Smoke test only (recommended first)

Purpose:

- validate Docker stack boot;
- validate query API reachability;
- validate SLO evaluation end-to-end.

Command:

```bash
bun run harness:smoke
```

### 4.2 Mode B: Full harness mixed-model run

Purpose:

- run multiple scripted tasks across providers/models;
- capture prompts, traces, steps, tool logs, artifacts, SLO reports.

Command:

```bash
bun run harness:run
```

Variant flags:

```bash
bun scripts/run_raw_agent_loops.ts --observability --report-only
bun scripts/run_raw_agent_loops.ts --observability --strict
bun scripts/run_raw_agent_loops.ts --observability --strict --keep-stack
```

### 4.3 Mode C: Manual stack control + UI usage

Purpose:

- keep stack up while using Desktop/TUI interactively;
- inspect status/endpoints on demand.

Commands:

```bash
bun run obs:up
bun run obs:status
bun scripts/observability_stack.ts endpoints --run-id default --json
bun run obs:down
```

## 5. Smoke Run Details (`harness:smoke`)

Entry point: `scripts/harness_smoke.ts`

### 5.1 What it does

1. Creates isolated stack config with run-specific ports.
2. Starts Docker Compose stack from `config/observability/docker-compose.yml`.
3. Forces local config:
   - `observabilityEnabled = true`
   - stack OTLP + query endpoints from runtime allocation
   - harness mode report-only, non-strict
4. Waits for metrics query readiness.
5. Runs a PromQL smoke query (`1`).
6. Runs SLO check requiring result `== 1`.
7. Exits non-zero on failure.
8. Tears stack down (unless `--keep-stack`).

### 5.2 CLI options

```bash
bun scripts/harness_smoke.ts --run-id my-smoke
bun scripts/harness_smoke.ts --run-id my-smoke --keep-stack
```

### 5.3 Expected success output shape

Example:

```json
{
  "ok": true,
  "runId": "smoke-...",
  "stack": {
    "projectName": "cowork-obs-smoke-...",
    "metricsBaseUrl": "http://127.0.0.1:18428"
  },
  "queryStatus": "ok",
  "sloPassed": true
}
```

## 6. Full Harness Loop Details (`harness:run`)

Entry point: `scripts/run_raw_agent_loops.ts`

### 6.1 Runtime behavior summary

- Builds a run root under:
  - `output/raw-agent-loop_mixed_<timestamp>/`
- Executes multiple run specs across providers.
- For each run:
  - creates isolated `workingDirectory`;
  - writes system prompt, user prompt, input messages;
  - runs model turn with retries;
  - captures step-level traces;
  - writes outputs and artifact index;
  - optionally evaluates SLO checks and writes reports.

### 6.2 Harness flags

- `--observability`
  - boot local stack per run;
  - inject observability endpoint env vars;
  - collect SLO/query artifacts.
- `--report-only`
  - failed SLO checks are recorded but do not fail run.
- `--strict`
  - sets strict mode and disables report-only;
  - failed SLO checks fail run.
- `--keep-stack`
  - keep per-run stack after completion (for deep inspection).

### 6.3 Environment injection during observability runs

Per run, script sets:

- `AGENT_OBSERVABILITY_ENABLED=true`
- `AGENT_OBS_OTLP_HTTP=<allocated vector endpoint>`
- `AGENT_OBS_LOGS_URL=<allocated logs endpoint>`
- `AGENT_OBS_METRICS_URL=<allocated metrics endpoint>`
- `AGENT_OBS_TRACES_URL=<allocated traces endpoint>`
- `AGENT_HARNESS_REPORT_ONLY=true|false`
- `AGENT_HARNESS_STRICT_MODE=true|false`

### 6.4 Run directory naming

Run directory is:

- `<run_id>_<provider>_<resolved_model>`

inside run root.

## 7. Artifacts: What To View And Why

After `harness:run`, inspect:

### 7.1 Run root files

- `manifest.json`
  - top-level run metadata;
  - selected harness flags;
  - masked key presence;
  - run IDs/provider/model matrix.
- `anthropic_models_raw.json` (or error file)
  - raw model list response used for alias resolution diagnostics.

### 7.2 Per-run files

- `run_meta.json`
  - resolved model/provider/max steps/observability-enabled status.
- `prompt.txt`
  - the user task prompt sent for that run.
- `system.txt`
  - resolved system prompt with skill context.
- `input_messages.json`
  - initial model message list.
- `attempts.json`
  - retry timeline (`ok`, `error`, retry delay).
- `trace_attempt-XX.json`
  - per-attempt detailed trace.
- `trace.json`
  - final canonical trace.
- `tool-log.txt`
  - line logs including tool call in/out envelopes.
- `final.txt`
  - final assistant text output.
- `final_reasoning.txt`
  - reasoning summary/stream capture if present.
- `response_messages.json`
  - structured response message payloads.
- `artifacts_index.json`
  - file inventory with hash/mtime/size.

Observability-enabled runs also include:

- `observability_endpoints.json`
- `slo_checks.json`
- `observability_queries.json`
- `slo_report.json`
- `observability_teardown_error.txt` (only if teardown fails)

### 7.3 Useful inspection commands

```bash
# latest run root
ls -1dt output/raw-agent-loop_mixed_* | head -n 1

# pretty print manifest
jq . output/raw-agent-loop_mixed_*/manifest.json

# list per-run directories
find output/raw-agent-loop_mixed_* -mindepth 1 -maxdepth 1 -type d | sort

# show SLO result summary for all runs
find output/raw-agent-loop_mixed_* -name slo_report.json -print0 | \
  xargs -0 -I{} sh -c 'echo "--- {}"; jq "{passed, strictMode, reportOnly, checks: [.checks[] | {id, pass, actual, op, threshold}]}" "{}"'
```

## 8. Using Harness In Desktop UI

Desktop store and feed wiring are in:

- `apps/desktop/src/app/store.ts`
- `apps/desktop/src/ui/ChatView.tsx`

### 8.1 Start Desktop dev app

```bash
bun run desktop:dev
```

### 8.2 Harness controls in chat view

At the top of the chat feed you now have:

- `Refresh context`
  - sends `harness_context_get`
- `Set default context`
  - sends `harness_context_set` with generated defaults
- `Run SLO checks`
  - sends `harness_slo_evaluate` with built-in check set

### 8.3 What to watch in feed

You should see dedicated cards for:

- observability status (enabled/disabled + endpoint summary)
- harness context (or "none")
- observability query result payloads
- SLO pass/fail summary with per-check lines

Notifications are also emitted for SLO pass/fail.

## 9. Using Harness In TUI

TUI wiring is in `src/tui/index.tsx`.

### 9.1 Start server + TUI

```bash
bun run serve
bun run tui -- --server ws://127.0.0.1:7337/ws
```

Or use default start flow:

```bash
bun run start
```

### 9.2 Harness slash commands

- `/hctx`
  - fetch current harness context.
- `/hctx set`
  - set default harness context payload.
- `/slo`
  - run default SLO check set.

### 9.3 TUI feed event visibility

TUI now renders cards for:

- `observability_status`
- `harness_context`
- `observability_query_result`
- `harness_slo_result`

On connect, TUI also auto-requests `harness_context_get`.

### 9.4 End-to-end: run in a target directory + watch live traces

This is the concrete "show me it working" flow for a single directory.

Assume target repo path:

```bash
export TARGET_DIR="/absolute/path/to/your/project"
```

#### 9.4.1 Bring up observability stack

```bash
bun run obs:up
bun run obs:status
bun scripts/observability_stack.ts endpoints --run-id default --json
```

Expected default local endpoints:

- OTLP HTTP: `http://127.0.0.1:14318`
- Logs API: `http://127.0.0.1:19428`
- Metrics API: `http://127.0.0.1:18428`
- Traces API: `http://127.0.0.1:10428`

#### 9.4.2 Start server with observability enabled for that target dir

Run in Terminal A:

```bash
AGENT_OBSERVABILITY_ENABLED=true \
AGENT_OBS_OTLP_HTTP=http://127.0.0.1:14318 \
AGENT_OBS_LOGS_URL=http://127.0.0.1:19428 \
AGENT_OBS_METRICS_URL=http://127.0.0.1:18428 \
AGENT_OBS_TRACES_URL=http://127.0.0.1:10428 \
bun src/server/index.ts --dir "$TARGET_DIR" --port 7337
```

#### 9.4.3 Option A: CLI run with prompt in that directory

Run in Terminal B:

```bash
bun run cli -- --dir "$TARGET_DIR"
```

At the `you>` prompt, send a task (example):

```text
List the top-level files in this directory and then summarize what kind of project this is in 2 bullets.
```

You are now running a real prompt in your specified directory.

#### 9.4.4 Option B: TUI run with prompt in that directory

If you prefer TUI instead of CLI:

```bash
bun run tui -- --server ws://127.0.0.1:7337/ws
```

Then:

1. run `/status` and confirm `CWD` equals `TARGET_DIR`;
2. send your prompt;
3. optional: run `/hctx set`, `/hctx`, and `/slo` to exercise harness controls.

#### 9.4.5 Watch traces live while prompt runs

Run in Terminal C:

```bash
while true; do
  clear
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  curl -sG 'http://127.0.0.1:10428/select/logsql/query' \
    --data-urlencode 'query=_time:[now-2m, now]' \
    --data-urlencode 'limit=50' | rg 'agent.turn|trace_id|span_id|name'
  sleep 2
done
```

What you should see:

- `agent.turn.started` span records as turns begin;
- `agent.turn.completed` (or `agent.turn.failed`) records on completion;
- `trace_id` / `span_id` fields for each emitted span.

Stop the watcher with `Ctrl+C`.

#### 9.4.6 Raw websocket trace query (explicit protocol check)

If you want a protocol-level assertion that trace querying works, run:

```bash
bun -e '
const ws = new WebSocket("ws://127.0.0.1:7337/ws");
let sessionId = null;
let asked = false;
ws.onopen = () => ws.send(JSON.stringify({ type: "client_hello", client: "trace-demo", version: "0.1.0" }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "server_hello") {
    sessionId = m.sessionId;
    ws.send(JSON.stringify({
      type: "user_message",
      sessionId,
      text: "Reply with exactly TRACE_DEMO_OK",
      clientMessageId: crypto.randomUUID()
    }));
    return;
  }
  if (m.type === "assistant_message" && !asked) {
    asked = true;
    ws.send(JSON.stringify({
      type: "observability_query",
      sessionId,
      query: { queryType: "traceql", query: "_time:[now-5m, now]", limit: 20 }
    }));
    return;
  }
  if (m.type === "observability_query_result") {
    console.log(JSON.stringify({ status: m.result.status, error: m.result.error ?? null }, null, 2));
    ws.close();
  }
};
'
```

Expected:

- status is `ok`;
- returned payload contains recent trace span rows (including `agent.turn.*` events).

## 10. Wire-Level Usage (Raw WebSocket)

If you are building another client, send/receive these protocol messages.

See full details in `docs/websocket-protocol.md`.

### 10.1 Request current context

```json
{
  "type": "harness_context_get",
  "sessionId": "<session-id>"
}
```

### 10.2 Set context

```json
{
  "type": "harness_context_set",
  "sessionId": "<session-id>",
  "context": {
    "runId": "manual-run-001",
    "taskId": "ticket-123",
    "objective": "Complete feature request and verify behavior.",
    "acceptanceCriteria": [
      "Feature works end-to-end",
      "Tests pass"
    ],
    "constraints": [
      "No schema changes",
      "No unrelated refactors"
    ],
    "metadata": {
      "source": "manual-client"
    }
  }
}
```

### 10.3 Run query

```json
{
  "type": "observability_query",
  "sessionId": "<session-id>",
  "query": {
    "queryType": "promql",
    "query": "sum(rate(vector_component_errors_total[5m]))"
  }
}
```

### 10.4 Run SLO checks

```json
{
  "type": "harness_slo_evaluate",
  "sessionId": "<session-id>",
  "checks": [
    {
      "id": "vector_errors",
      "type": "custom",
      "queryType": "promql",
      "query": "sum(rate(vector_component_errors_total[5m]))",
      "op": "<=",
      "threshold": 0,
      "windowSec": 300
    }
  ]
}
```

### 10.5 Expected server events

- `observability_status`
- `harness_context`
- `observability_query_result`
- `harness_slo_result`

## 11. Observability Stack Operations

Stack definition:

- Compose: `config/observability/docker-compose.yml`
- Vector config: `config/observability/vector/vector.toml`

Pinned images include:

- `timberio/vector:0.40.1-debian`
- `victoriametrics/victoria-logs:v1.11.0-victorialogs`
- `victoriametrics/victoria-metrics:v1.103.0`
- `victoriametrics/victoria-traces:v0.7.1`

### 11.1 Manual lifecycle commands

```bash
bun scripts/observability_stack.ts up --run-id default
bun scripts/observability_stack.ts status --run-id default
bun scripts/observability_stack.ts endpoints --run-id default --json
bun scripts/observability_stack.ts down --run-id default
```

State file path:

- `.agent/observability-stack/<run-id>.json`

### 11.2 Confirm containers

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

### 11.3 Query endpoints directly

Example PromQL query:

```bash
curl -sG 'http://127.0.0.1:8428/api/v1/query' \
  --data-urlencode 'query=up' | jq .
```

Example logs query endpoint shape:

```bash
curl -sG 'http://127.0.0.1:9428/select/logsql/query' \
  --data-urlencode 'query=_time:[now-5m, now] level:error' \
  --data-urlencode 'limit=50'
```

## 12. CI Behavior

Workflow file: `.github/workflows/ci.yml`

Jobs:

- `checks`
  - `bun install`
  - `bun run docs:check`
  - `bun test`
- `harness_smoke`
  - Docker availability check
  - `bun run harness:smoke -- --run-id ci-<run_id>-<attempt>`

Local parity command set:

```bash
bun run docs:check
bun test
bun run harness:smoke
```

## 13. One-Call Live Model Probe

When you want to prove model auth + generation quickly without full harness loop:

```bash
bun -e 'import { loadConfig, getModel } from "./src/config"; import { generateText } from "ai"; const cfg = await loadConfig({ cwd: process.cwd() }); const out = await generateText({ model: getModel(cfg), system: "You are a diagnostics assistant.", prompt: "Reply with exactly: HARNESS_MODEL_OK", maxRetries: 0, providerOptions: cfg.providerOptions }); console.log(out.text);'
```

Expected output:

```text
HARNESS_MODEL_OK
```

## 14. Troubleshooting

### 14.1 "docker compose ... failed"

Checks:

- Docker app/daemon running.
- `docker compose version` works.
- no restrictive corporate proxy breaking image pulls.

### 14.2 "Observability is disabled for this session"

Cause:

- session config has `observabilityEnabled=false` and no injected overrides.

Fix:

- run through `harness:smoke` or `harness:run --observability`;
- or set:
  - `AGENT_OBSERVABILITY_ENABLED=true`
  - query and OTLP endpoint vars.

### 14.3 `harness:run` exits for missing keys

Cause:

- one or more required provider env vars absent.

Fix:

- export all required keys before run.

### 14.4 SLO checks fail in strict mode

Expected if checks violate thresholds.

Options:

- use report-only mode while iterating:
  - `--report-only`
- keep strict mode and improve app behavior until checks pass.

### 14.5 Stale state from manual stack runs

If state file exists but containers are gone:

```bash
rm -f .agent/observability-stack/default.json
```

Then run `obs:up` again.

### 14.6 Need to keep stack for inspection

Use:

```bash
bun run harness:smoke -- --keep-stack
# or
bun scripts/run_raw_agent_loops.ts --observability --keep-stack --report-only
```

Remember cleanup:

```bash
bun run obs:down
```

### 14.7 Port already allocated during `harness:smoke`

Example error:

```text
Bind for 0.0.0.0:10428 failed: port is already allocated
```

Cause:

- another observability stack is already bound to default host ports (commonly from `obs:up` with `run-id=default`).

Fix:

```bash
bun run obs:down
bun run harness:smoke
```

If you intentionally need two stacks at once, use different host ports/run-ids via `scripts/observability_stack.ts`.

## 15. Recommended Daily Workflow

1. `bun run docs:check`
2. `bun test`
3. `bun run harness:smoke`
4. Run Desktop or TUI and exercise `/hctx`, `/slo` (or Desktop buttons)
5. For deep validation, run `bun run harness:run`
6. Inspect `output/raw-agent-loop_mixed_*` artifacts
7. Tear down any kept stack

## 16. Related Docs

- `docs/harness/index.md`
- `docs/harness/observability.md`
- `docs/harness/context.md`
- `docs/harness/slo.md`
- `docs/websocket-protocol.md`

## 17. Next.js Web Portal (Realtime)

Portal location:

- `apps/portal`

Run from repo root:

```bash
bun run portal:dev
```

Open:

- `http://localhost:3000`

If port 3000 is occupied:

```bash
cd apps/portal
bun run dev -- --port 3060
```

### 17.1 What the portal reads

The portal reads and combines:

- run artifacts under `output/raw-agent-loop_mixed_*`
- observability stack state from `.agent/observability-stack/default.json`
- live query results from configured logs/metrics/traces endpoints

### 17.2 Realtime behavior

- run list updates via Server-Sent Events (`/api/stream/runs`) every ~2s
- selected run detail auto-refreshes every ~4s
- observability health/metrics snapshot refreshes every ~3s

No manual browser refresh is required during active runs.

### 17.3 How to watch a run live end-to-end

Terminal A:

```bash
bun run obs:up
```

Terminal B (start portal):

```bash
bun run portal:dev
```

Terminal C (start your harness workload):

```bash
bun run harness:run
```

As files are written under `output/raw-agent-loop_mixed_*`, the portal run catalog and detail panes update in near real time.

### 17.4 Portal API endpoints

- `GET /api/runs`
  - current run-root + run summary snapshot
- `GET /api/runs/detail?runRoot=<name>&runDir=<name>`
  - detail payload for one run directory
- `GET /api/stream/runs`
  - SSE stream for live run snapshot updates
- `GET /api/observability/snapshot`
  - current endpoint health + live metrics summary
- `POST /api/observability/query`
  - run ad-hoc `logql` / `promql` / `traceql` query from the portal

### 17.5 Endpoint overrides

Optional portal-specific env overrides:

- `HARNESS_REPO_ROOT`
- `HARNESS_OBS_OTLP_HTTP`
- `HARNESS_OBS_LOGS_URL`
- `HARNESS_OBS_METRICS_URL`
- `HARNESS_OBS_TRACES_URL`

Example:

```bash
HARNESS_REPO_ROOT=/Users/me/Projects/agent-coworker \
HARNESS_OBS_TRACES_URL=http://127.0.0.1:10428 \
bun run portal:dev
```

### 17.6 Endpoint auto-detection behavior

If you do **not** set `HARNESS_OBS_*` overrides, the portal resolves endpoints in this order:

1. `HARNESS_OBS_*` environment variables (if all are set)
2. `.agent/observability-stack/default.json`
3. most recent `.agent/observability-stack/*.json` state file
4. `config/defaults.json` observability endpoints
5. host-mapped local fallback:
   - OTLP `http://127.0.0.1:14318`
   - Logs `http://127.0.0.1:19428`
   - Metrics `http://127.0.0.1:18428`
   - Traces `http://127.0.0.1:10428`

When multiple candidates are available, the portal probes them and picks the most reachable set, which avoids common cases where default config points at container-internal ports while you are querying from the host.
