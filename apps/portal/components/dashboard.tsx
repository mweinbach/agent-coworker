"use client";

import { useEffect, useMemo, useState } from "react";

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
  updatedAtMs: number;
};

type HarnessRunRootSummary = {
  runRootName: string;
  createdAt: string | null;
  harness: {
    reportOnly: boolean;
    strictMode: boolean;
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
  artifactsIndex: Array<Record<string, unknown>>;
  toolLogTail: string[];
  files: string[];
  updatedAtMs: number;
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

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleReconnect = () => {
      if (disposed || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, 5_000);
    };

    const connect = () => {
      if (disposed) return;

      if (source) {
        source.close();
      }

      setRunsConnection("connecting");

      const nextSource = new EventSource("/api/stream/runs?limitRoots=40&intervalMs=2000");
      source = nextSource;

      nextSource.onopen = () => {
        if (disposed || source !== nextSource) return;
        setRunsConnection("connected");
        setRunsError("");
      };

      nextSource.onmessage = (event) => {
        if (disposed || source !== nextSource) return;
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

      nextSource.onerror = () => {
        if (disposed || source !== nextSource) return;
        setRunsConnection("error");
        nextSource.close();
        source = null;
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      if (source) {
        source.close();
      }
      setRunsConnection("disconnected");
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

  return (
    <main className="portal-shell">
      <header className="portal-header">
        <div>
          <p className="eyebrow">Harness Portal</p>
          <h1>Realtime Harness Runs</h1>
          <p className="subtle">
            A live Next.js view over run artifacts, attempts, and traces.
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
                        reportOnly={String(root.harness.reportOnly)} | strict={String(root.harness.strictMode)}
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
                <p className="micro">observability health: {selectedRunSummary.observabilityHealthStatus ?? "unknown"}</p>
                {selectedRunSummary.observabilityHealthReason ? (
                  <p className="micro">health reason: {selectedRunSummary.observabilityHealthReason}</p>
                ) : null}
                {selectedRunSummary.observabilityHealthMessage ? (
                  <p className="micro">health message: {selectedRunSummary.observabilityHealthMessage}</p>
                ) : null}
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
                <h3>Tool Log Tail (last 220 lines)</h3>
                <pre>{runDetail?.toolLogTail.join("\n") || "(empty)"}</pre>
              </article>
            </div>
          ) : (
            <p className="empty">No run selected.</p>
          )}
        </section>
      </section>
    </main>
  );
}
