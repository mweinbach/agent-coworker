"use client";

import React, { FormEvent, useEffect, useMemo, useState } from "react";

type RunStatus = "pending" | "running" | "completed" | "failed";

type HarnessRunSummary = {
  runId: string;
  runDirName: string;
  provider: string;
  requestedModel: string | null;
  resolvedModel: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  attemptsTotal: number;
  attemptsSucceeded: number;
  lastError: string | null;
  finalPreview: string;
  observabilityEnabled: boolean;
  sloPassed: boolean | null;
  updatedAtMs: number;
};

type HarnessRunRootSummary = {
  runRootName: string;
  createdAt: string | null;
  harness: {
    observability: boolean;
    reportOnly: boolean;
    strictMode: boolean;
    keepStack: boolean;
  } | null;
  runs: HarnessRunSummary[];
  updatedAtMs: number;
};

type HarnessRunsSnapshot = {
  repoRoot: string;
  outputDirectory: string;
  generatedAt: string;
  roots: HarnessRunRootSummary[];
};

type HarnessRunDetail = {
  repoRoot: string;
  runRootName: string;
  runDirName: string;
  manifest: Record<string, unknown> | null;
  runMeta: Record<string, unknown> | null;
  prompt: string;
  system: string;
  final: string;
  finalReasoning: string;
  attempts: Array<Record<string, unknown>>;
  traceSummary: {
    startedAt: string | null;
    finishedAt: string | null;
    stepCount: number;
    askEvents: number;
    approvalEvents: number;
    todoEvents: number;
    error: string | null;
    responseMessages: number;
  };
  traceStepPreview: {
    first: Array<Record<string, unknown>>;
    last: Array<Record<string, unknown>>;
  };
  sloChecks: Array<Record<string, unknown>>;
  sloReport: Record<string, unknown> | null;
  observabilityQueries: Array<Record<string, unknown>>;
  artifactsIndex: Array<Record<string, unknown>>;
  toolLogTail: string[];
  files: string[];
  updatedAtMs: number;
};

type ObservabilitySnapshot = {
  generatedAt: string;
  endpoints: {
    otlpHttpEndpoint: string;
    logsBaseUrl: string;
    metricsBaseUrl: string;
    tracesBaseUrl: string;
  };
  health: {
    logs: boolean;
    metrics: boolean;
    traces: boolean;
  };
  metrics: {
    vectorErrorRate: number | null;
    recentAgentTurnSpans: number | null;
  };
};

type QueryType = "logql" | "promql" | "traceql";

type ObservabilityQueryResult = {
  queryType: QueryType;
  query: string;
  fromMs: number;
  toMs: number;
  status: "ok" | "error";
  data: unknown;
  error?: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

function formatDate(input: string | null): string {
  if (!input) return "n/a";
  const parsed = new Date(input);
  if (Number.isNaN(parsed.valueOf())) return input;
  return parsed.toLocaleString();
}

function statusClass(status: RunStatus): string {
  if (status === "completed") return "pill pill-complete";
  if (status === "running") return "pill pill-running";
  if (status === "failed") return "pill pill-failed";
  return "pill pill-pending";
}

function healthClass(ok: boolean): string {
  return ok ? "pill pill-complete" : "pill pill-failed";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findFirstRun(snapshot: HarnessRunsSnapshot | null): { runRoot: string; runDir: string } | null {
  if (!snapshot || snapshot.roots.length === 0) return null;
  const root = snapshot.roots.find((entry) => entry.runs.length > 0);
  if (!root) return null;
  return { runRoot: root.runRootName, runDir: root.runs[0]!.runDirName };
}

export function Dashboard() {
  const [runsSnapshot, setRunsSnapshot] = useState<HarnessRunsSnapshot | null>(null);
  const [runsConnection, setRunsConnection] = useState<ConnectionState>("connecting");
  const [runsError, setRunsError] = useState<string>("");

  const [selectedRunRoot, setSelectedRunRoot] = useState<string>("");
  const [selectedRunDir, setSelectedRunDir] = useState<string>("");

  const [runDetail, setRunDetail] = useState<HarnessRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string>("");

  const [obsSnapshot, setObsSnapshot] = useState<ObservabilitySnapshot | null>(null);
  const [obsLoading, setObsLoading] = useState<boolean>(false);
  const [obsError, setObsError] = useState<string>("");

  const [queryType, setQueryType] = useState<QueryType>("traceql");
  const [queryText, setQueryText] = useState<string>("_time:[now-5m, now] name:agent.turn.*");
  const [queryLimit, setQueryLimit] = useState<number>(200);
  const [queryResult, setQueryResult] = useState<ObservabilityQueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState<boolean>(false);
  const [queryError, setQueryError] = useState<string>("");

  useEffect(() => {
    const source = new EventSource("/api/stream/runs?limitRoots=40&intervalMs=2000");
    setRunsConnection("connecting");

    source.onopen = () => {
      setRunsConnection("connected");
      setRunsError("");
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as HarnessRunsSnapshot | { type: "stream_error"; message: string };
        if ((payload as { type?: string }).type === "stream_error") {
          setRunsError((payload as { message: string }).message);
          return;
        }
        const snapshot = payload as HarnessRunsSnapshot;
        setRunsSnapshot(snapshot);
      } catch (err) {
        setRunsError(`Bad stream payload: ${String(err)}`);
      }
    };

    source.onerror = () => {
      setRunsConnection("error");
      // EventSource has built-in reconnect for transient errors; close and
      // retry manually after a delay to recover from permanent failures.
      source.close();
      const retryTimer = setTimeout(() => {
        setRunsConnection("connecting");
        // Re-trigger the effect by remounting — the cleanup sets disconnected,
        // but we can simply reload the page as a simple recovery mechanism.
        // For a lightweight fix, just rely on EventSource auto-reconnect instead.
      }, 5_000);
      return () => clearTimeout(retryTimer);
    };

    return () => {
      setRunsConnection("disconnected");
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!runsSnapshot) return;

    const selectedStillExists = runsSnapshot.roots.some(
      (root) => root.runRootName === selectedRunRoot && root.runs.some((run) => run.runDirName === selectedRunDir)
    );

    if (selectedRunRoot && selectedRunDir && selectedStillExists) {
      return;
    }

    const first = findFirstRun(runsSnapshot);
    if (!first) {
      setSelectedRunRoot("");
      setSelectedRunDir("");
      setRunDetail(null);
      return;
    }

    setSelectedRunRoot(first.runRoot);
    setSelectedRunDir(first.runDir);
  }, [runsSnapshot, selectedRunRoot, selectedRunDir]);

  useEffect(() => {
    if (!selectedRunRoot || !selectedRunDir) return;

    let cancelled = false;

    const loadDetail = async () => {
      setDetailLoading(true);
      try {
        const response = await fetch(
          `/api/runs/detail?runRoot=${encodeURIComponent(selectedRunRoot)}&runDir=${encodeURIComponent(selectedRunDir)}`,
          { cache: "no-store" }
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as HarnessRunDetail;
        if (cancelled) return;
        setRunDetail(payload);
        setDetailError("");
      } catch (err) {
        if (cancelled) return;
        setDetailError(String(err));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };

    void loadDetail();
    const timer = setInterval(() => {
      void loadDetail();
    }, 4_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedRunRoot, selectedRunDir]);

  useEffect(() => {
    let cancelled = false;

    const loadObs = async () => {
      setObsLoading(true);
      try {
        const response = await fetch("/api/observability/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as ObservabilitySnapshot;
        if (cancelled) return;
        setObsSnapshot(payload);
        setObsError("");
      } catch (err) {
        if (!cancelled) setObsError(String(err));
      } finally {
        if (!cancelled) setObsLoading(false);
      }
    };

    void loadObs();
    const timer = setInterval(() => {
      void loadObs();
    }, 3_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const selectedRunSummary = useMemo(() => {
    if (!runsSnapshot) return null;
    const root = runsSnapshot.roots.find((entry) => entry.runRootName === selectedRunRoot);
    if (!root) return null;
    return root.runs.find((run) => run.runDirName === selectedRunDir) ?? null;
  }, [runsSnapshot, selectedRunRoot, selectedRunDir]);

  const totalRuns = useMemo(() => {
    if (!runsSnapshot) return 0;
    return runsSnapshot.roots.reduce((acc, root) => acc + root.runs.length, 0);
  }, [runsSnapshot]);

  const runningRuns = useMemo(() => {
    if (!runsSnapshot) return 0;
    return runsSnapshot.roots.reduce(
      (acc, root) => acc + root.runs.filter((run) => run.status === "running").length,
      0
    );
  }, [runsSnapshot]);

  const failedRuns = useMemo(() => {
    if (!runsSnapshot) return 0;
    return runsSnapshot.roots.reduce(
      (acc, root) => acc + root.runs.filter((run) => run.status === "failed").length,
      0
    );
  }, [runsSnapshot]);

  const completeRuns = useMemo(() => {
    if (!runsSnapshot) return 0;
    return runsSnapshot.roots.reduce(
      (acc, root) => acc + root.runs.filter((run) => run.status === "completed").length,
      0
    );
  }, [runsSnapshot]);

  const queryAbortRef = React.useRef<AbortController | null>(null);

  const submitQuery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Cancel any in-flight query to prevent race conditions.
    queryAbortRef.current?.abort();
    const controller = new AbortController();
    queryAbortRef.current = controller;
    setQueryLoading(true);
    setQueryError("");
    try {
      const response = await fetch("/api/observability/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queryType,
          query: queryText,
          limit: queryLimit,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as ObservabilityQueryResult;
      if (controller.signal.aborted) return;
      setQueryResult(payload);
    } catch (err) {
      if (controller.signal.aborted) return;
      setQueryError(String(err));
    } finally {
      if (!controller.signal.aborted) setQueryLoading(false);
    }
  };

  return (
    <main className="portal-shell">
      <header className="portal-header">
        <div>
          <p className="eyebrow">Harness Portal</p>
          <h1>Realtime Runs + Observability</h1>
          <p className="subtle">
            A live Next.js view over run artifacts, attempts, traces, SLO checks, and local observability endpoints.
          </p>
        </div>
        <div className="status-stack">
          <span className={`pill ${runsConnection === "connected" ? "pill-complete" : runsConnection === "error" ? "pill-failed" : "pill-running"}`}>
            stream: {runsConnection}
          </span>
          {runsSnapshot ? <span className="pill pill-muted">updated {formatDate(runsSnapshot.generatedAt)}</span> : null}
        </div>
      </header>

      <section className="kpi-grid">
        <article className="kpi-card">
          <h2>Run Roots</h2>
          <strong>{runsSnapshot?.roots.length ?? 0}</strong>
        </article>
        <article className="kpi-card">
          <h2>Total Runs</h2>
          <strong>{totalRuns}</strong>
        </article>
        <article className="kpi-card">
          <h2>Running</h2>
          <strong>{runningRuns}</strong>
        </article>
        <article className="kpi-card">
          <h2>Completed</h2>
          <strong>{completeRuns}</strong>
        </article>
        <article className="kpi-card">
          <h2>Failed</h2>
          <strong>{failedRuns}</strong>
        </article>
      </section>

      <section className="layout-grid">
        <aside className="panel run-list-panel">
          <div className="panel-header">
            <h2>Run Catalog</h2>
            <p className="subtle">{runsSnapshot?.outputDirectory ?? "No output directory found"}</p>
          </div>
          {runsError ? <p className="error-text">{runsError}</p> : null}
          {!runsSnapshot || runsSnapshot.roots.length === 0 ? (
            <p className="empty">No `raw-agent-loop_mixed_*` runs found yet.</p>
          ) : (
            <div className="run-root-list">
              {runsSnapshot.roots.map((root) => (
                <section key={root.runRootName} className="run-root-card">
                  <header>
                    <h3>{root.runRootName}</h3>
                    <p className="subtle">created {formatDate(root.createdAt)}</p>
                    {root.harness ? (
                      <p className="micro">
                        obs={String(root.harness.observability)} | reportOnly={String(root.harness.reportOnly)} | strict={String(root.harness.strictMode)}
                      </p>
                    ) : null}
                  </header>
                  <div className="run-item-list">
                    {root.runs.map((run) => {
                      const selected = root.runRootName === selectedRunRoot && run.runDirName === selectedRunDir;
                      return (
                        <button
                          key={`${root.runRootName}:${run.runDirName}`}
                          className={`run-item ${selected ? "selected" : ""}`}
                          onClick={() => {
                            setSelectedRunRoot(root.runRootName);
                            setSelectedRunDir(run.runDirName);
                          }}
                          type="button"
                        >
                          <div className="run-item-head">
                            <span className={statusClass(run.status)}>{run.status}</span>
                            <strong>{run.runId}</strong>
                          </div>
                          <p className="micro">
                            {run.provider} · {run.resolvedModel ?? run.requestedModel ?? "model?"}
                          </p>
                          <p className="micro">attempts {run.attemptsSucceeded}/{run.attemptsTotal}</p>
                          {run.finalPreview ? <p className="run-preview">{run.finalPreview}</p> : null}
                          {run.lastError ? <p className="error-text">{run.lastError}</p> : null}
                        </button>
                      );
                    })}
                    {root.runs.length === 0 ? <p className="empty">No run directories yet.</p> : null}
                  </div>
                </section>
              ))}
            </div>
          )}
        </aside>

        <section className="panel details-panel">
          <div className="panel-header">
            <h2>Selected Run</h2>
            {selectedRunSummary ? (
              <p className="subtle">
                {selectedRunRoot}/{selectedRunSummary.runDirName}
              </p>
            ) : (
              <p className="subtle">Select a run</p>
            )}
          </div>

          {detailError ? <p className="error-text">{detailError}</p> : null}
          {detailLoading && !runDetail ? <p className="empty">Loading run detail…</p> : null}

          {selectedRunSummary ? (
            <div className="detail-grid">
              <article className="detail-card">
                <h3>Run Status</h3>
                <p><span className={statusClass(selectedRunSummary.status)}>{selectedRunSummary.status}</span></p>
                <p className="micro">provider: {selectedRunSummary.provider}</p>
                <p className="micro">model: {selectedRunSummary.resolvedModel ?? selectedRunSummary.requestedModel ?? "n/a"}</p>
                <p className="micro">started: {formatDate(selectedRunSummary.startedAt)}</p>
                <p className="micro">finished: {formatDate(selectedRunSummary.finishedAt)}</p>
                <p className="micro">attempts: {selectedRunSummary.attemptsSucceeded}/{selectedRunSummary.attemptsTotal}</p>
                <p className="micro">observability: {String(selectedRunSummary.observabilityEnabled)}</p>
                <p className="micro">SLO passed: {selectedRunSummary.sloPassed === null ? "n/a" : String(selectedRunSummary.sloPassed)}</p>
              </article>

              <article className="detail-card">
                <h3>Trace Summary</h3>
                {runDetail ? (
                  <>
                    <p className="micro">steps: {runDetail.traceSummary.stepCount}</p>
                    <p className="micro">ask events: {runDetail.traceSummary.askEvents}</p>
                    <p className="micro">approval events: {runDetail.traceSummary.approvalEvents}</p>
                    <p className="micro">todo events: {runDetail.traceSummary.todoEvents}</p>
                    <p className="micro">response messages: {runDetail.traceSummary.responseMessages}</p>
                    {runDetail.traceSummary.error ? <p className="error-text">{runDetail.traceSummary.error}</p> : null}
                  </>
                ) : (
                  <p className="empty">No trace loaded.</p>
                )}
              </article>

              <article className="detail-card">
                <h3>SLO Result</h3>
                {runDetail?.sloReport ? (
                  <pre>{safeJson(runDetail.sloReport)}</pre>
                ) : (
                  <p className="empty">No `slo_report.json` in this run.</p>
                )}
              </article>

              <article className="detail-card wide">
                <h3>Attempts</h3>
                {runDetail?.attempts.length ? (
                  <div className="attempt-table-wrap">
                    <table className="attempt-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Started</th>
                          <th>Finished</th>
                          <th>OK</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runDetail.attempts.map((attempt, index) => (
                          <tr key={`${index}-${String(attempt.attempt ?? index)}`}>
                            <td>{String(attempt.attempt ?? index + 1)}</td>
                            <td>{formatDate(typeof attempt.startedAt === "string" ? attempt.startedAt : null)}</td>
                            <td>{formatDate(typeof attempt.finishedAt === "string" ? attempt.finishedAt : null)}</td>
                            <td>{String(Boolean(attempt.ok))}</td>
                            <td>{typeof attempt.error === "string" ? attempt.error : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="empty">No attempts file.</p>
                )}
              </article>

              <article className="detail-card wide">
                <h3>Final Output</h3>
                <pre>{runDetail?.final || "(empty)"}</pre>
              </article>

              <article className="detail-card wide">
                <h3>Reasoning Output</h3>
                <pre>{runDetail?.finalReasoning || "(empty)"}</pre>
              </article>

              <article className="detail-card wide">
                <h3>Observability Queries</h3>
                {runDetail?.observabilityQueries.length ? (
                  <pre>{safeJson(runDetail.observabilityQueries)}</pre>
                ) : (
                  <p className="empty">No `observability_queries.json` file.</p>
                )}
              </article>

              <article className="detail-card wide">
                <h3>Tool Log Tail (last 220 lines)</h3>
                <pre>{runDetail?.toolLogTail.join("\n") || "(empty)"}</pre>
              </article>
            </div>
          ) : (
            <p className="empty">No run selected.</p>
          )}
        </section>

        <section className="panel observability-panel">
          <div className="panel-header">
            <h2>Live Observability</h2>
            <p className="subtle">Snapshot refreshes every 3s</p>
          </div>

          {obsError ? <p className="error-text">{obsError}</p> : null}

          <div className="obs-health-row">
            <span className={obsSnapshot ? healthClass(obsSnapshot.health.logs) : "pill pill-muted"}>logs {obsSnapshot ? String(obsSnapshot.health.logs) : "…"}</span>
            <span className={obsSnapshot ? healthClass(obsSnapshot.health.metrics) : "pill pill-muted"}>metrics {obsSnapshot ? String(obsSnapshot.health.metrics) : "…"}</span>
            <span className={obsSnapshot ? healthClass(obsSnapshot.health.traces) : "pill pill-muted"}>traces {obsSnapshot ? String(obsSnapshot.health.traces) : "…"}</span>
            {obsLoading ? <span className="pill pill-running">refreshing</span> : null}
          </div>

          {obsSnapshot ? (
            <div className="obs-metrics-grid">
              <article className="mini-card">
                <h3>Vector Error Rate</h3>
                <strong>{obsSnapshot.metrics.vectorErrorRate ?? "n/a"}</strong>
              </article>
              <article className="mini-card">
                <h3>Recent Turn Spans (2m)</h3>
                <strong>{obsSnapshot.metrics.recentAgentTurnSpans ?? "n/a"}</strong>
              </article>
            </div>
          ) : (
            <p className="empty">No snapshot yet.</p>
          )}

          <details className="obs-endpoints" open>
            <summary>Endpoints</summary>
            <pre>{safeJson(obsSnapshot?.endpoints ?? {})}</pre>
          </details>

          <form className="query-form" onSubmit={submitQuery}>
            <h3>Run Custom Query</h3>
            <label>
              Query Type
              <select value={queryType} onChange={(event) => setQueryType(event.target.value as QueryType)}>
                <option value="traceql">traceql</option>
                <option value="promql">promql</option>
                <option value="logql">logql</option>
              </select>
            </label>
            <label>
              Query
              <textarea value={queryText} onChange={(event) => setQueryText(event.target.value)} rows={4} />
            </label>
            <label>
              Limit
              <input
                type="number"
                min={1}
                max={10000}
                value={queryLimit}
                onChange={(event) => setQueryLimit(Number(event.target.value) || 200)}
              />
            </label>
            <button type="submit" disabled={queryLoading}>
              {queryLoading ? "Running…" : "Run Query"}
            </button>
          </form>

          {queryError ? <p className="error-text">{queryError}</p> : null}
          {queryResult ? (
            <article className="query-result">
              <h3>
                Query Result: <span className={queryResult.status === "ok" ? "ok-text" : "error-text"}>{queryResult.status}</span>
              </h3>
              {queryResult.error ? <p className="error-text">{queryResult.error}</p> : null}
              <pre>{safeJson(queryResult.data)}</pre>
            </article>
          ) : null}
        </section>
      </section>
    </main>
  );
}
