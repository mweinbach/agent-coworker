import { describe, expect, test } from "bun:test";

import type { AgentConfig, ObservabilityQueryRequest } from "../src/types";
import { runObservabilityQuery } from "../src/observability/query";

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

/** Helper: build a mock fetch that records calls and responds based on a handler. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    return handler(url, init);
  };
  (fn as any).calls = calls;
  return fn as any;
}

function getCalls(f: typeof fetch): Array<{ url: string; method: string; body?: string }> {
  return (f as any).calls;
}

// ---------------------------------------------------------------------------
// logql
// ---------------------------------------------------------------------------

describe("runObservabilityQuery - logql", () => {
  test("logql query succeeds on first GET candidate", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch((url) => {
      return new Response(JSON.stringify({ streams: [{ values: [["ts1", "line1"]] }] }), {
        status: 200,
      });
    });

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    // Only one call should have been made since the first candidate succeeded.
    const calls = getCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/select/logsql/query");
    expect(calls[0].url).toContain("query=");
  });

  test("logql query falls back to POST when GET returns 400", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch((url, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return new Response("bad request", { status: 400 });
      }
      // POST succeeds
      return new Response(JSON.stringify({ streams: [] }), { status: 200 });
    });

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    const calls = getCalls(fetchImpl);
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("GET");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toBeDefined();
    const body = JSON.parse(calls[1].body!);
    expect(body.query).toBe('{app="agent"}');
  });
});

// ---------------------------------------------------------------------------
// promql
// ---------------------------------------------------------------------------

describe("runObservabilityQuery - promql", () => {
  test("promql query_range succeeds on first candidate", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => {
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } }),
        { status: 200 }
      );
    });

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "promql", query: "up" },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    const calls = getCalls(fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/v1/query_range");
    expect(calls[0].url).toContain("query=up");
    expect(calls[0].url).toContain("start=");
    expect(calls[0].url).toContain("end=");
    expect(calls[0].url).toContain("step=");
  });

  test("promql falls back to instant query when query_range fails", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch((url) => {
      if (url.includes("/api/v1/query_range")) {
        return new Response("query_range not supported", { status: 400 });
      }
      return new Response(
        JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }),
        { status: 200 }
      );
    });

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "promql", query: "up" },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    const calls = getCalls(fetchImpl);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/api/v1/query_range");
    expect(calls[1].url).toContain("/api/v1/query");
    // Instant query should use 'time' parameter, not 'start'/'end'/'step'
    expect(calls[1].url).toContain("time=");
    expect(calls[1].url).not.toContain("start=");
  });
});

// ---------------------------------------------------------------------------
// limit clamping
// ---------------------------------------------------------------------------

describe("runObservabilityQuery - limit clamping", () => {
  test("limit > 10000 gets clamped to 10000", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("[]", { status: 200 }));

    await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}', limit: 99999 },
      { fetchImpl }
    );

    const calls = getCalls(fetchImpl);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("10000");
  });

  test("limit < 1 gets clamped to 1", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("[]", { status: 200 }));

    await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}', limit: -5 },
      { fetchImpl }
    );

    const calls = getCalls(fetchImpl);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("1");
  });

  test("limit undefined defaults to 200", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("[]", { status: 200 }));

    await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    const calls = getCalls(fetchImpl);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("200");
  });

  test("limit NaN defaults to 200", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("[]", { status: 200 }));

    await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}', limit: NaN },
      { fetchImpl }
    );

    const calls = getCalls(fetchImpl);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("limit")).toBe("200");
  });
});

// ---------------------------------------------------------------------------
// time window
// ---------------------------------------------------------------------------

describe("runObservabilityQuery - time window", () => {
  test("fromMs/toMs not specified defaults to 5-minute window from now", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("[]", { status: 200 }));
    const before = Date.now();

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    const after = Date.now();
    // toMs should be approximately now
    expect(result.toMs).toBeGreaterThanOrEqual(before);
    expect(result.toMs).toBeLessThanOrEqual(after);
    // fromMs should be toMs - 300s (5 minutes)
    expect(result.fromMs).toBe(result.toMs - 300_000);
  });

  test("custom fromMs/toMs passed through correctly", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("[]", { status: 200 }));

    const fromMs = 1700000000000;
    const toMs = 1700000060000;

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}', fromMs, toMs },
      { fetchImpl }
    );

    expect(result.fromMs).toBe(fromMs);
    expect(result.toMs).toBe(toMs);

    // Verify the URL contains the correct timestamps
    const calls = getCalls(fetchImpl);
    const url = new URL(calls[0].url);
    expect(url.searchParams.get("start")).toBe(String(fromMs));
    expect(url.searchParams.get("end")).toBe(String(toMs));
  });
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe("runObservabilityQuery - error handling", () => {
  test("all candidates fail returns error with last error message", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("service unavailable", { status: 503 }));

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("503");
    expect(result.error).toContain("service unavailable");
    expect(result.data).toBeNull();
  });

  test("fetch network error returns error result (does not throw)", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => {
      throw new TypeError("fetch failed");
    });

    // Must not throw; should return an error result.
    const result = await runObservabilityQuery(
      cfg,
      { queryType: "promql", query: "up" },
      { fetchImpl }
    );

    expect(result.status).toBe("error");
    expect(result.error).toContain("fetch failed");
    expect(result.data).toBeNull();
  });

  test("response body is not JSON returns raw text as data", async () => {
    const cfg = makeConfig();
    const rawText = "this is not json, just plain text";
    const fetchImpl = mockFetch(() => new Response(rawText, { status: 200 }));

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    expect(result.data).toBe(rawText);
  });

  test("empty response body returns null as data", async () => {
    const cfg = makeConfig();
    const fetchImpl = mockFetch(() => new Response("", { status: 200 }));

    const result = await runObservabilityQuery(
      cfg,
      { queryType: "logql", query: '{app="agent"}' },
      { fetchImpl }
    );

    expect(result.status).toBe("ok");
    expect(result.data).toBeNull();
  });
});
