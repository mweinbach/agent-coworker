import { describe, expect, test } from "bun:test";

import type { AgentConfig } from "../src/types";
import { runObservabilityQuery } from "../src/observability/query";
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

describe("runObservabilityQuery", () => {
  test("returns disabled error when observability is off", async () => {
    const cfg = { ...makeConfig(), observabilityEnabled: false };
    const result = await runObservabilityQuery(cfg, { queryType: "promql", query: "up" });
    expect(result.status).toBe("error");
    expect(result.error).toContain("disabled");
  });

  test("returns parsed response data on success", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ status: "success", data: { result: [{ value: [123, "0"] }] } }), {
        status: 200,
      })) as any;
    const result = await runObservabilityQuery(cfg, { queryType: "promql", query: "up" }, { fetchImpl });
    expect(result.status).toBe("ok");
    expect((result.data as any).status).toBe("success");
  });

  test("traceql falls back to logsql endpoint when traceql path is unsupported", async () => {
    const cfg = makeConfig();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/select/traceql/query")) {
        return new Response("unsupported", { status: 400 });
      }
      if (url.includes("/select/logsql/query")) {
        return new Response(JSON.stringify([{ name: "agent.turn.completed", trace_id: "abc" }]), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as any;

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "traceql", query: "_time:[now-5m, now]" },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    expect(calls.some((url) => url.includes("/select/traceql/query"))).toBe(true);
    expect(calls.some((url) => url.includes("/select/logsql/query"))).toBe(true);
  });
});

describe("evaluateHarnessSlo", () => {
  test("passes when check operator condition is met", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [{ metric: {}, value: [1738736700, "0"] }] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      cfg,
      [
        {
          id: "vector_errors",
          type: "custom",
          queryType: "promql",
          query: "sum(rate(vector_component_errors_total[5m]))",
          op: "<=",
          threshold: 0,
          windowSec: 300,
        },
      ],
      { fetchImpl, nowMs: 1738736700000 }
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(0);
  });

  test("treats empty Prometheus envelopes as zero-valued checks", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "vector", result: [] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      cfg,
      [
        {
          id: "empty_vector",
          type: "custom",
          queryType: "promql",
          query: "sum(rate(nonexistent_metric_total[5m]))",
          op: "<=",
          threshold: 0,
          windowSec: 300,
        },
      ],
      { fetchImpl, nowMs: 1738736700000 }
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]?.pass).toBe(true);
    expect(result.checks[0]?.actual).toBe(0);
  });

  test("does not read tuple timestamps as sample values", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { result: [{ value: [1738736700, "NaN"] }] },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      cfg,
      [
        {
          id: "nan_tuple",
          type: "custom",
          queryType: "promql",
          query: "up",
          op: "<=",
          threshold: 1,
          windowSec: 60,
        },
      ],
      { fetchImpl, nowMs: 1738736700000 }
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0]?.actual).toBeNull();
    expect(result.checks[0]?.reason).toContain("numeric");
  });

  test("fails when no numeric value can be extracted", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ status: "success", data: { result: [{ value: ["x", "NaN"] }] } }), {
        status: 200,
      })) as any;

    const result = await evaluateHarnessSlo(
      cfg,
      [
        {
          id: "bad",
          type: "custom",
          queryType: "promql",
          query: "up",
          op: "<=",
          threshold: 1,
          windowSec: 60,
        },
      ],
      { fetchImpl, nowMs: 1738736700000 }
    );

    expect(result.passed).toBe(false);
    expect(result.checks[0]?.reason).toContain("numeric");
  });

  test("prefers Prometheus vector sample values over numeric metric labels", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "vector",
            result: [{ metric: { quantile: "0.99", le: "0.5" }, value: [1738736700, "0.04"] }],
          },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      cfg,
      [
        {
          id: "vector_label_vs_sample",
          type: "custom",
          queryType: "promql",
          query: "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))",
          op: "==",
          threshold: 0.04,
          windowSec: 300,
        },
      ],
      { fetchImpl, nowMs: 1738736700000 }
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]?.actual).toBe(0.04);
    expect(result.checks[0]?.pass).toBe(true);
  });

  test("prefers latest Prometheus matrix sample over numeric metric labels", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { quantile: "0.99" },
                values: [
                  [1738736400, "0.22"],
                  [1738736700, "0.28"],
                ],
              },
            ],
          },
        }),
        { status: 200 }
      )) as any;

    const result = await evaluateHarnessSlo(
      cfg,
      [
        {
          id: "matrix_label_vs_sample",
          type: "custom",
          queryType: "promql",
          query: "rate(http_request_duration_seconds_sum[5m])",
          op: "==",
          threshold: 0.28,
          windowSec: 300,
        },
      ],
      { fetchImpl, nowMs: 1738736700000 }
    );

    expect(result.passed).toBe(true);
    expect(result.checks[0]?.actual).toBe(0.28);
    expect(result.checks[0]?.pass).toBe(true);
  });
});
