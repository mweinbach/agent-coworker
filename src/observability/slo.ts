import type {
  AgentConfig,
  HarnessSloCheck,
  HarnessSloCheckResult,
  HarnessSloOperator,
  HarnessSloResult,
  ObservabilityQueryResult,
} from "../types";
import { runObservabilityQuery } from "./query";

function compare(actual: number, op: HarnessSloOperator, threshold: number): boolean {
  switch (op) {
    case "<":
      return actual < threshold;
    case "<=":
      return actual <= threshold;
    case ">":
      return actual > threshold;
    case ">=":
      return actual >= threshold;
    case "==":
      return actual === threshold;
    case "!=":
      return actual !== threshold;
  }
}

function extractNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    return null;
  }
  if (Array.isArray(value)) {
    // Prometheus often encodes samples as [unixTimestamp, sampleValue].
    if (value.length === 2) {
      const sampleValue = extractNumeric(value[1]);
      if (sampleValue !== null) return sampleValue;
    }
    for (const item of value) {
      const nested = extractNumeric(item);
      if (nested !== null) return nested;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {
      const n = extractNumeric(nested);
      if (n !== null) return n;
    }
  }
  return null;
}

function toCheckResult(check: HarnessSloCheck, queryResult: ObservabilityQueryResult): HarnessSloCheckResult {
  if (queryResult.status !== "ok") {
    return {
      id: check.id,
      type: check.type,
      queryType: check.queryType,
      query: check.query,
      op: check.op,
      threshold: check.threshold,
      windowSec: check.windowSec,
      actual: null,
      pass: false,
      reason: queryResult.error ?? "Observability query failed",
    };
  }

  const actual = extractNumeric(queryResult.data);
  if (actual === null) {
    return {
      id: check.id,
      type: check.type,
      queryType: check.queryType,
      query: check.query,
      op: check.op,
      threshold: check.threshold,
      windowSec: check.windowSec,
      actual: null,
      pass: false,
      reason: "Unable to derive numeric value from query result",
    };
  }

  return {
    id: check.id,
    type: check.type,
    queryType: check.queryType,
    query: check.query,
    op: check.op,
    threshold: check.threshold,
    windowSec: check.windowSec,
    actual,
    pass: compare(actual, check.op, check.threshold),
  };
}

export async function evaluateHarnessSlo(
  config: AgentConfig,
  checks: HarnessSloCheck[],
  deps?: { fetchImpl?: typeof fetch; nowMs?: number }
): Promise<HarnessSloResult> {
  const nowMs = deps?.nowMs ?? Date.now();
  const results: HarnessSloCheckResult[] = [];

  for (const check of checks) {
    const queryResult = await runObservabilityQuery(
      config,
      {
        queryType: check.queryType,
        query: check.query,
        fromMs: nowMs - check.windowSec * 1000,
        toMs: nowMs,
      },
      { fetchImpl: deps?.fetchImpl }
    );
    results.push(toCheckResult(check, queryResult));
  }

  return {
    reportOnly: config.harness?.reportOnly ?? true,
    strictMode: config.harness?.strictMode ?? false,
    passed: results.every((result) => result.pass),
    fromMs: checks.length > 0 ? nowMs - Math.max(...checks.map((check) => check.windowSec)) * 1000 : nowMs,
    toMs: nowMs,
    checks: results,
  };
}
