import type { AgentConfig, ObservabilityQueryRequest, ObservabilityQueryResult, ObservabilityQueryType } from "../types";

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 200;
  return Math.max(1, Math.min(10_000, Math.floor(limit)));
}

function appendQuery(url: string, params: Record<string, string | number | undefined>): string {
  const parsed = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parsed.searchParams.set(k, String(v));
  }
  return parsed.toString();
}

function parseAnyResponse(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function computeWindow(config: AgentConfig, req: ObservabilityQueryRequest): { fromMs: number; toMs: number } {
  const toMs = typeof req.toMs === "number" && Number.isFinite(req.toMs) ? Math.floor(req.toMs) : Date.now();
  const defaultWindowMs = Math.max(1, config.observability?.defaultWindowSec ?? 300) * 1000;
  const fromMs =
    typeof req.fromMs === "number" && Number.isFinite(req.fromMs) ? Math.floor(req.fromMs) : toMs - defaultWindowMs;
  return { fromMs, toMs };
}

function buildCandidates(
  queryType: ObservabilityQueryType,
  baseUrl: string,
  query: string,
  fromMs: number,
  toMs: number,
  limit: number
): Array<{ url: string; method: "GET" | "POST"; body?: string }> {
  const startSec = Math.floor(fromMs / 1000);
  const endSec = Math.floor(toMs / 1000);
  const stepSec = Math.max(1, Math.floor((toMs - fromMs) / 1000 / 60));

  if (queryType === "promql") {
    return [
      {
        url: appendQuery(`${baseUrl.replace(/\/$/, "")}/api/v1/query_range`, {
          query,
          start: startSec,
          end: endSec,
          step: stepSec,
        }),
        method: "GET",
      },
      {
        url: appendQuery(`${baseUrl.replace(/\/$/, "")}/api/v1/query`, { query, time: endSec }),
        method: "GET",
      },
    ];
  }

  if (queryType === "logql") {
    return [
      {
        url: appendQuery(`${baseUrl.replace(/\/$/, "")}/select/logsql/query`, {
          query,
          start: fromMs,
          end: toMs,
          limit,
        }),
        method: "GET",
      },
      {
        url: `${baseUrl.replace(/\/$/, "")}/select/logsql/query`,
        method: "POST",
        body: JSON.stringify({ query, start: fromMs, end: toMs, limit }),
      },
    ];
  }

  return [
    {
      url: appendQuery(`${baseUrl.replace(/\/$/, "")}/select/traceql/query`, {
        query,
        start: fromMs,
        end: toMs,
        limit,
      }),
      method: "GET",
    },
    {
      url: `${baseUrl.replace(/\/$/, "")}/select/traceql/query`,
      method: "POST",
      body: JSON.stringify({ query, start: fromMs, end: toMs, limit }),
    },
    {
      // VictoriaTraces v0.7.x exposes span search over /select/logsql/query.
      // Keep this fallback so trace querying works across endpoint variants.
      url: appendQuery(`${baseUrl.replace(/\/$/, "")}/select/logsql/query`, {
        query,
        start: fromMs,
        end: toMs,
        limit,
      }),
      method: "GET",
    },
    {
      url: `${baseUrl.replace(/\/$/, "")}/select/logsql/query`,
      method: "POST",
      body: JSON.stringify({ query, start: fromMs, end: toMs, limit }),
    },
  ];
}

export async function runObservabilityQuery(
  config: AgentConfig,
  req: ObservabilityQueryRequest,
  deps?: { fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<ObservabilityQueryResult> {
  const query = req.query.trim();
  const { fromMs, toMs } = computeWindow(config, req);
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  if (!config.observabilityEnabled || !config.observability) {
    return {
      queryType: req.queryType,
      query,
      fromMs,
      toMs,
      status: "error",
      data: null,
      error: "Observability is disabled for this session.",
    };
  }

  const baseUrl =
    req.queryType === "logql"
      ? config.observability.queryApi.logsBaseUrl
      : req.queryType === "promql"
        ? config.observability.queryApi.metricsBaseUrl
        : config.observability.queryApi.tracesBaseUrl;

  const limit = clampLimit(req.limit);
  const candidates = buildCandidates(req.queryType, baseUrl, query, fromMs, toMs, limit);
  let lastError: string | null = null;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(candidate.url, {
        method: candidate.method,
        headers: candidate.body ? { "content-type": "application/json" } : undefined,
        body: candidate.body,
        signal: controller.signal,
      });
      const text = await res.text();
      clearTimeout(timer);
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${text.slice(0, 400)}`;
        continue;
      }
      return {
        queryType: req.queryType,
        query,
        fromMs,
        toMs,
        status: "ok",
        data: parseAnyResponse(text),
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = String(err);
    }
  }

  return {
    queryType: req.queryType,
    query,
    fromMs,
    toMs,
    status: "error",
    data: null,
    error: lastError ?? "Unknown observability query failure",
  };
}
