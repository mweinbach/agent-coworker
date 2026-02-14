import fs from "node:fs/promises";
import path from "node:path";

import { resolveRepoRoot } from "./harness";

export type ObservabilityQueryType = "logql" | "promql" | "traceql";

export interface ObservabilityEndpoints {
  otlpHttpEndpoint: string;
  logsBaseUrl: string;
  metricsBaseUrl: string;
  tracesBaseUrl: string;
}

export interface ObservabilityQueryRequest {
  queryType: ObservabilityQueryType;
  query: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export interface ObservabilityQueryResult {
  queryType: ObservabilityQueryType;
  query: string;
  fromMs: number;
  toMs: number;
  status: "ok" | "error";
  data: unknown;
  error?: string;
}

export interface ObservabilitySnapshot {
  generatedAt: string;
  endpoints: ObservabilityEndpoints;
  health: {
    logs: boolean;
    metrics: boolean;
    traces: boolean;
  };
  metrics: {
    vectorErrorRate: number | null;
    recentAgentTurnSpans: number | null;
  };
}

function appendQuery(url: string, params: Record<string, string | number | undefined>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parsed.searchParams.set(key, String(value));
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toEndpoints(value: unknown): ObservabilityEndpoints | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const otlpHttpEndpoint = typeof obj.otlpHttpEndpoint === "string" ? obj.otlpHttpEndpoint : null;
  const logsBaseUrl = typeof obj.logsBaseUrl === "string" ? obj.logsBaseUrl : null;
  const metricsBaseUrl = typeof obj.metricsBaseUrl === "string" ? obj.metricsBaseUrl : null;
  const tracesBaseUrl = typeof obj.tracesBaseUrl === "string" ? obj.tracesBaseUrl : null;
  if (!otlpHttpEndpoint || !logsBaseUrl || !metricsBaseUrl || !tracesBaseUrl) return null;
  return { otlpHttpEndpoint, logsBaseUrl, metricsBaseUrl, tracesBaseUrl };
}

function readEnvEndpointOverrides(): Partial<ObservabilityEndpoints> {
  const override: Partial<ObservabilityEndpoints> = {};
  const entries: Array<[keyof ObservabilityEndpoints, string | undefined]> = [
    ["otlpHttpEndpoint", process.env.HARNESS_OBS_OTLP_HTTP],
    ["logsBaseUrl", process.env.HARNESS_OBS_LOGS_URL],
    ["metricsBaseUrl", process.env.HARNESS_OBS_METRICS_URL],
    ["tracesBaseUrl", process.env.HARNESS_OBS_TRACES_URL],
  ];
  for (const [key, value] of entries) {
    const normalized = value?.trim();
    if (!normalized) continue;
    override[key] = normalized;
  }
  return override;
}

function hasEndpointOverrides(value: Partial<ObservabilityEndpoints>): boolean {
  return (
    value.otlpHttpEndpoint !== undefined ||
    value.logsBaseUrl !== undefined ||
    value.metricsBaseUrl !== undefined ||
    value.tracesBaseUrl !== undefined
  );
}

function applyEndpointOverrides(
  endpoints: ObservabilityEndpoints,
  overrides: Partial<ObservabilityEndpoints>
): ObservabilityEndpoints {
  if (!hasEndpointOverrides(overrides)) return endpoints;
  return {
    otlpHttpEndpoint: overrides.otlpHttpEndpoint ?? endpoints.otlpHttpEndpoint,
    logsBaseUrl: overrides.logsBaseUrl ?? endpoints.logsBaseUrl,
    metricsBaseUrl: overrides.metricsBaseUrl ?? endpoints.metricsBaseUrl,
    tracesBaseUrl: overrides.tracesBaseUrl ?? endpoints.tracesBaseUrl,
  };
}

function hostMappedFallbackEndpoints(): ObservabilityEndpoints {
  return {
    otlpHttpEndpoint: "http://127.0.0.1:14318",
    logsBaseUrl: "http://127.0.0.1:19428",
    metricsBaseUrl: "http://127.0.0.1:18428",
    tracesBaseUrl: "http://127.0.0.1:10428",
  };
}

function dedupeEndpoints(candidates: ObservabilityEndpoints[]): ObservabilityEndpoints[] {
  const seen = new Set<string>();
  const unique: ObservabilityEndpoints[] = [];
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

async function endpointHealthScore(endpoints: ObservabilityEndpoints): Promise<number> {
  const [logs, metrics, traces] = await Promise.all([
    checkHealth(`${endpoints.logsBaseUrl.replace(/\/$/, "")}/`),
    checkHealth(`${endpoints.metricsBaseUrl.replace(/\/$/, "")}/metrics`),
    checkHealth(`${endpoints.tracesBaseUrl.replace(/\/$/, "")}/`),
  ]);
  return Number(logs) + Number(metrics) + Number(traces);
}

async function readLatestStackStateEndpoints(repoRoot: string): Promise<ObservabilityEndpoints | null> {
  const stateDir = path.join(repoRoot, ".agent", "observability-stack");
  if (!(await pathExists(stateDir))) return null;

  let entries: Array<{ filePath: string; mtimeMs: number }> = [];
  try {
    const dirEntries = await fs.readdir(stateDir, { withFileTypes: true });
    entries = (
      await Promise.all(
        dirEntries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => {
            const filePath = path.join(stateDir, entry.name);
            const st = await fs.stat(filePath);
            return { filePath, mtimeMs: st.mtimeMs };
          })
      )
    ).sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const parsed = await readJsonFile<{ stack?: { endpoints?: unknown } }>(entry.filePath);
    const endpoints = toEndpoints(parsed?.stack?.endpoints);
    if (endpoints) return endpoints;
  }

  return null;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 200;
  return Math.max(1, Math.min(10_000, Math.floor(limit)));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
        method: "GET",
        url: appendQuery(`${baseUrl.replace(/\/$/, "")}/api/v1/query_range`, {
          query,
          start: startSec,
          end: endSec,
          step: stepSec,
        }),
      },
      {
        method: "GET",
        url: appendQuery(`${baseUrl.replace(/\/$/, "")}/api/v1/query`, { query, time: endSec }),
      },
    ];
  }

  if (queryType === "logql") {
    return [
      {
        method: "GET",
        url: appendQuery(`${baseUrl.replace(/\/$/, "")}/select/logsql/query`, {
          query,
          start: fromMs,
          end: toMs,
          limit,
        }),
      },
      {
        method: "POST",
        url: `${baseUrl.replace(/\/$/, "")}/select/logsql/query`,
        body: JSON.stringify({ query, start: fromMs, end: toMs, limit }),
      },
    ];
  }

  return [
    {
      method: "GET",
      url: appendQuery(`${baseUrl.replace(/\/$/, "")}/select/traceql/query`, {
        query,
        start: fromMs,
        end: toMs,
        limit,
      }),
    },
    {
      method: "POST",
      url: `${baseUrl.replace(/\/$/, "")}/select/traceql/query`,
      body: JSON.stringify({ query, start: fromMs, end: toMs, limit }),
    },
    {
      method: "GET",
      url: appendQuery(`${baseUrl.replace(/\/$/, "")}/select/logsql/query`, {
        query,
        start: fromMs,
        end: toMs,
        limit,
      }),
    },
    {
      method: "POST",
      url: `${baseUrl.replace(/\/$/, "")}/select/logsql/query`,
      body: JSON.stringify({ query, start: fromMs, end: toMs, limit }),
    },
  ];
}

function safeExtractPromValue(data: unknown): number | null {
  const root = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  const payload = root && typeof root.data === "object" && root.data !== null ? (root.data as Record<string, unknown>) : null;
  const result = payload && Array.isArray(payload.result) ? payload.result : [];
  if (result.length === 0) return null;
  const first = typeof result[0] === "object" && result[0] !== null ? (result[0] as Record<string, unknown>) : null;
  const value = first && Array.isArray(first.value) ? first.value : null;
  if (!value || value.length < 2) return null;
  const num = Number(value[1]);
  return Number.isFinite(num) ? num : null;
}

function safeCountRows(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\n+/).filter((line) => line.trim().length > 0).length;
  }
  return null;
}

async function checkHealth(url: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(url, { method: "GET" }, 2_500);
    return res.ok;
  } catch {
    return false;
  }
}

export async function resolveObservabilityEndpoints(): Promise<ObservabilityEndpoints> {
  const envOverrides = readEnvEndpointOverrides();
  const fromEnv = toEndpoints(envOverrides);
  if (fromEnv) return fromEnv;

  const repoRoot = await resolveRepoRoot();
  const candidates: ObservabilityEndpoints[] = [];

  const stackStatePath = path.join(repoRoot, ".agent", "observability-stack", "default.json");
  if (await pathExists(stackStatePath)) {
    const parsed = await readJsonFile<{ stack?: { endpoints?: Partial<ObservabilityEndpoints> } }>(stackStatePath);
    const endpoints = toEndpoints(parsed?.stack?.endpoints);
    if (endpoints) candidates.push(endpoints);
  }

  const latestStateEndpoints = await readLatestStackStateEndpoints(repoRoot);
  if (latestStateEndpoints) candidates.push(latestStateEndpoints);

  const defaults = await readJsonFile<{
    observability?: {
      otlpHttpEndpoint?: string;
      queryApi?: {
        logsBaseUrl?: string;
        metricsBaseUrl?: string;
        tracesBaseUrl?: string;
      };
    };
  }>(path.join(repoRoot, "config", "defaults.json"));

  candidates.push({
    otlpHttpEndpoint: defaults?.observability?.otlpHttpEndpoint ?? "http://127.0.0.1:14318",
    logsBaseUrl: defaults?.observability?.queryApi?.logsBaseUrl ?? "http://127.0.0.1:19428",
    metricsBaseUrl: defaults?.observability?.queryApi?.metricsBaseUrl ?? "http://127.0.0.1:18428",
    tracesBaseUrl: defaults?.observability?.queryApi?.tracesBaseUrl ?? "http://127.0.0.1:10428",
  });
  candidates.push(hostMappedFallbackEndpoints());

  const unique = dedupeEndpoints(candidates);
  if (unique.length === 1) return applyEndpointOverrides(unique[0], envOverrides);

  const scores = await Promise.all(unique.map((candidate) => endpointHealthScore(candidate)));
  let best = unique[0];
  let bestScore = -1;
  for (let i = 0; i < unique.length; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      best = unique[i];
    }
  }

  return applyEndpointOverrides(best, envOverrides);
}

export async function runObservabilityQuery(req: ObservabilityQueryRequest): Promise<ObservabilityQueryResult> {
  const endpoints = await resolveObservabilityEndpoints();
  const query = req.query.trim();
  const nowMs = Date.now();
  const toMs = typeof req.toMs === "number" && Number.isFinite(req.toMs) ? Math.floor(req.toMs) : nowMs;
  const fromMs = typeof req.fromMs === "number" && Number.isFinite(req.fromMs) ? Math.floor(req.fromMs) : toMs - 5 * 60_000;
  const limit = clampLimit(req.limit);

  const baseUrl =
    req.queryType === "logql"
      ? endpoints.logsBaseUrl
      : req.queryType === "promql"
        ? endpoints.metricsBaseUrl
        : endpoints.tracesBaseUrl;

  const candidates = buildCandidates(req.queryType, baseUrl, query, fromMs, toMs, limit);
  let lastError: string | null = null;

  for (const candidate of candidates) {
    try {
      const res = await fetchWithTimeout(
        candidate.url,
        {
          method: candidate.method,
          headers: candidate.body ? { "content-type": "application/json" } : undefined,
          body: candidate.body,
        },
        8_000
      );
      const text = await res.text();
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

export async function getObservabilitySnapshot(): Promise<ObservabilitySnapshot> {
  const endpoints = await resolveObservabilityEndpoints();
  const [logs, metrics, traces] = await Promise.all([
    checkHealth(`${endpoints.logsBaseUrl.replace(/\/$/, "")}/`),
    checkHealth(`${endpoints.metricsBaseUrl.replace(/\/$/, "")}/metrics`),
    checkHealth(`${endpoints.tracesBaseUrl.replace(/\/$/, "")}/`),
  ]);

  const [vectorErrResult, turnsResult] = await Promise.all([
    runObservabilityQuery({
      queryType: "promql",
      query: "sum(rate(vector_component_errors_total[5m]))",
      toMs: Date.now(),
      fromMs: Date.now() - 5 * 60_000,
      limit: 1,
    }),
    runObservabilityQuery({
      queryType: "traceql",
      query: "_time:[now-2m, now] name:agent.turn.*",
      toMs: Date.now(),
      fromMs: Date.now() - 2 * 60_000,
      limit: 300,
    }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    endpoints,
    health: { logs, metrics, traces },
    metrics: {
      vectorErrorRate: vectorErrResult.status === "ok" ? safeExtractPromValue(vectorErrResult.data) : null,
      recentAgentTurnSpans: turnsResult.status === "ok" ? safeCountRows(turnsResult.data) : null,
    },
  };
}
