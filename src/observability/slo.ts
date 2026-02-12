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
    default: {
      const _exhaustive: never = op;
      return false;
    }
  }
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isPrometheusSampleTuple(value: unknown[]): boolean {
  if (value.length !== 2) return false;
  const timestamp = parseFiniteNumber(value[0]);
  const sample = value[1];
  return timestamp !== null && (typeof sample === "number" || typeof sample === "string");
}

function extractNumeric(value: unknown): number | null {
  const scalar = parseFiniteNumber(value);
  if (scalar !== null) return scalar;
  if (Array.isArray(value)) {
    if (isPrometheusSampleTuple(value)) {
      // Prometheus samples are [unixTimestamp, sampleValue]; never treat timestamp as metric value.
      return parseFiniteNumber(value[1]);
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

function hasEmptyPrometheusResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.result) && record.result.length === 0) return true;
  if ("data" in record) {
    return hasEmptyPrometheusResult(record.data);
  }
  return false;
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

  // Distinguish between empty results and unparseable data:
  // - Empty arrays/objects (no errors/data) → treat as 0
  // - Unparseable data (NaN, invalid strings) → fail the check
  let actual = extractNumeric(queryResult.data);
  if (actual === null) {
    // Check if the data is an empty structure (array/object with no meaningful content)
    const isEmptyStructure =
      queryResult.data === null ||
      queryResult.data === undefined ||
      (Array.isArray(queryResult.data) && queryResult.data.length === 0) ||
      (typeof queryResult.data === "object" &&
        !Array.isArray(queryResult.data) &&
        (Object.keys(queryResult.data).length === 0 || hasEmptyPrometheusResult(queryResult.data)));

    if (isEmptyStructure) {
      actual = 0; // Treat empty results as zero
    } else {
      // Data exists but can't be parsed - this is a failure
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

  const results = await Promise.all(
    checks.map(async (check) => {
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
      return toCheckResult(check, queryResult);
    })
  );

  return {
    reportOnly: config.harness?.reportOnly ?? true,
    strictMode: config.harness?.strictMode ?? false,
    passed: results.every((result) => result.pass),
    fromMs: checks.length > 0 ? nowMs - Math.max(...checks.map((check) => check.windowSec)) * 1000 : nowMs,
    toMs: nowMs,
    checks: results,
  };
}
