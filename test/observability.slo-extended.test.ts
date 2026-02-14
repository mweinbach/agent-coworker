import { describe, expect, test } from "bun:test";

import type { AgentConfig, HarnessSloCheck } from "../src/types";
import { evaluateHarnessSlo } from "../src/observability/slo";

function makeConfig(): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    subAgentModel: "gpt-5.2",
    workingDirectory: "/tmp/work",
    outputDirectory: "/tmp/out",
    uploadsDirectory: "/tmp/uploads",
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: "/tmp/work/.agent",
    userAgentDir: "/tmp/home/.agent",
    builtInDir: "/tmp/built-in",
    builtInConfigDir: "/tmp/built-in/config",
    skillsDirs: [],
    memoryDirs: [],
    configDirs: [],
    enableMcp: false,
    observabilityEnabled: true,
    observability: {
      mode: "local_docker",
      otlpHttpEndpoint: "http://127.0.0.1:4318",
      queryApi: {
        logsBaseUrl: "http://127.0.0.1:9428",
        metricsBaseUrl: "http://127.0.0.1:8428",
        tracesBaseUrl: "http://127.0.0.1:10428",
      },
      defaultWindowSec: 300,
    },
    harness: {
      reportOnly: true,
      strictMode: false,
    },
  };
}

const NOW_MS = 1738736700000;

function promResponse(sampleValue: string | number): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        status: "success",
        data: { resultType: "vector", result: [{ metric: {}, value: [1738736700, String(sampleValue)] }] },
      }),
      { status: 200 }
    )) as any;
}

function makeCheck(overrides: Partial<HarnessSloCheck> = {}): HarnessSloCheck {
  return {
    id: "test_check",
    type: "custom",
    queryType: "promql",
    query: "up",
    op: "<=",
    threshold: 10,
    windowSec: 300,
    ...overrides,
  };
}

describe("evaluateHarnessSlo - comparison operators", () => {
  test('operator "<" with actual < threshold passes', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "lt_pass", op: "<", threshold: 10 })],
      { fetchImpl: promResponse(5), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(5);
  });

  test('operator "<" with actual == threshold fails', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "lt_fail", op: "<", threshold: 10 })],
      { fetchImpl: promResponse(10), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.actual).toBe(10);
  });

  test('operator ">" with actual > threshold passes', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "gt_pass", op: ">", threshold: 5 })],
      { fetchImpl: promResponse(10), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(10);
  });

  test('operator ">" with actual == threshold fails', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "gt_fail", op: ">", threshold: 10 })],
      { fetchImpl: promResponse(10), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.pass).toBe(false);
  });

  test('operator ">=" with actual == threshold passes', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "gte_eq", op: ">=", threshold: 10 })],
      { fetchImpl: promResponse(10), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(10);
  });

  test('operator "==" with actual == threshold passes', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "eq_pass", op: "==", threshold: 42 })],
      { fetchImpl: promResponse(42), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(42);
  });

  test('operator "==" with actual != threshold fails', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "eq_fail", op: "==", threshold: 42 })],
      { fetchImpl: promResponse(99), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.actual).toBe(99);
  });

  test('operator "!=" with actual != threshold passes', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "ne_pass", op: "!=", threshold: 42 })],
      { fetchImpl: promResponse(99), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(99);
  });

  test('operator "!=" with actual == threshold fails', async () => {
    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "ne_fail", op: "!=", threshold: 42 })],
      { fetchImpl: promResponse(42), nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.actual).toBe(42);
  });
});

describe("evaluateHarnessSlo - multiple checks", () => {
  test("all pass -> result.passed = true", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [{ metric: {}, value: [1738736700, "5"] }] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [
        makeCheck({ id: "c1", op: "<", threshold: 10 }),
        makeCheck({ id: "c2", op: "<=", threshold: 5 }),
        makeCheck({ id: "c3", op: "!=", threshold: 99 }),
      ],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  test("mixed pass/fail -> result.passed = false", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [{ metric: {}, value: [1738736700, "5"] }] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [
        makeCheck({ id: "c1", op: "<", threshold: 10 }),  // 5 < 10 -> pass
        makeCheck({ id: "c2", op: ">", threshold: 10 }),  // 5 > 10 -> fail
      ],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[1]?.pass).toBe(false);
  });

  test("all fail -> result.passed = false", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [{ metric: {}, value: [1738736700, "50"] }] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [
        makeCheck({ id: "c1", op: "<", threshold: 10 }),   // 50 < 10 -> fail
        makeCheck({ id: "c2", op: "==", threshold: 10 }),  // 50 == 10 -> fail
      ],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks.every((c) => !c.pass)).toBe(true);
  });
});

describe("evaluateHarnessSlo - config flags", () => {
  test("reportOnly is propagated from config.harness", async () => {
    const cfg = makeConfig();
    cfg.harness = { reportOnly: false, strictMode: false };

    const result = await evaluateHarnessSlo(cfg, [], { nowMs: NOW_MS });
    expect(result.reportOnly).toBe(false);
  });

  test("strictMode is propagated from config.harness", async () => {
    const cfg = makeConfig();
    cfg.harness = { reportOnly: true, strictMode: true };

    const result = await evaluateHarnessSlo(cfg, [], { nowMs: NOW_MS });
    expect(result.strictMode).toBe(true);
  });

  test("missing harness config defaults to reportOnly=true, strictMode=false", async () => {
    const cfg = makeConfig();
    delete (cfg as any).harness;

    const result = await evaluateHarnessSlo(cfg, [], { nowMs: NOW_MS });
    expect(result.reportOnly).toBe(true);
    expect(result.strictMode).toBe(false);
  });
});

describe("evaluateHarnessSlo - edge cases", () => {
  test("empty checks array -> passed=true (vacuous truth), no checks", async () => {
    const result = await evaluateHarnessSlo(makeConfig(), [], { nowMs: NOW_MS });
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  test("query failure -> check.pass=false with error reason", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("Internal Server Error", { status: 500 })) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "fail_query" })],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0]?.pass).toBe(false);
    expect(result.checks[0]?.actual).toBeNull();
    expect(result.checks[0]?.reason).toBeDefined();
  });

  test("extractNumeric from nested object {data: {result: [{value: [ts, '42']}]}} -> 42", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { result: [{ value: [1738736700, "42"] }] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "nested", op: "==", threshold: 42 })],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.actual).toBe(42);
    expect(result.checks[0]?.pass).toBe(true);
  });

  test("extractNumeric from plain number -> works", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify(7), { status: 200 })) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "plain_num", op: "==", threshold: 7 })],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.actual).toBe(7);
    expect(result.checks[0]?.pass).toBe(true);
  });

  test('hasEmptyPrometheusResult with {status:"success", data:{result:[]}} -> treats as 0', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({ status: "success", data: { result: [] } }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      makeConfig(),
      [makeCheck({ id: "empty_prom", op: "==", threshold: 0 })],
      { fetchImpl, nowMs: NOW_MS }
    );
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.actual).toBe(0);
    expect(result.checks[0]?.pass).toBe(true);
  });
});
