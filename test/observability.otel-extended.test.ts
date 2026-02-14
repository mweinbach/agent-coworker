import { describe, expect, test } from "bun:test";

import type { AgentConfig } from "../src/types";
import { emitObservabilityEvent } from "../src/observability/otel";

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

/** Helper: capture fetch calls and return the parsed span from the OTLP body. */
function captureFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response("", { status: 200 });
  }) as any;
  return { calls, fetchImpl };
}

function extractSpan(calls: Array<{ url: string; init: RequestInit | undefined }>) {
  const body = JSON.parse(String(calls[0]?.init?.body));
  return body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
}

describe("resolveTraceIngestUrl edge cases via emitObservabilityEvent", () => {
  test("OTLP endpoint already ends in /v1/traces → uses it as-is", async () => {
    const cfg = makeConfig();
    cfg.observability!.otlpHttpEndpoint = "http://otel-collector:4318/v1/traces";
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      { name: "test.span", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://otel-collector:4318/v1/traces");
  });

  test("OTLP endpoint already ends in /insert/opentelemetry/v1/traces → uses it as-is", async () => {
    const cfg = makeConfig();
    cfg.observability!.otlpHttpEndpoint =
      "http://victoria:10428/insert/opentelemetry/v1/traces";
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      { name: "test.span", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://victoria:10428/insert/opentelemetry/v1/traces"
    );
  });

  test("OTLP endpoint is a non-URL string → appends /v1/traces", async () => {
    const cfg = makeConfig();
    cfg.observability!.otlpHttpEndpoint = "just-a-host";
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      { name: "test.span", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("just-a-host/v1/traces");
  });

  test("config.observability is undefined → no-op (no fetch called)", async () => {
    const cfg = makeConfig();
    cfg.observability = undefined;
    cfg.observabilityEnabled = false;
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      { name: "test.span", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );

    expect(calls).toHaveLength(0);
  });

  test("observabilityEnabled is true but config.observability is undefined → no-op", async () => {
    const cfg = makeConfig();
    cfg.observability = undefined;
    cfg.observabilityEnabled = true;
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      { name: "test.span", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );

    expect(calls).toHaveLength(0);
  });
});

describe("emitObservabilityEvent span body edge cases", () => {
  test("event with empty attributes object → span has minimal attributes (event.at)", async () => {
    const cfg = makeConfig();
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      {
        name: "test.empty-attrs",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
        attributes: {},
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    const span = extractSpan(calls);
    // Should only contain event.at (no duration.ms since durationMs is undefined)
    expect(span.attributes).toHaveLength(1);
    expect(span.attributes[0].key).toBe("event.at");
    expect(span.attributes[0].value.stringValue).toBe("2026-02-11T18:00:00.000Z");
  });

  test("event with no durationMs → span attributes do NOT include duration.ms", async () => {
    const cfg = makeConfig();
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      {
        name: "test.no-duration",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
        attributes: { foo: "bar" },
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    const span = extractSpan(calls);
    const hasDuration = span.attributes.some((a: any) => a.key === "duration.ms");
    expect(hasDuration).toBe(false);
  });

  test("event with attributes of all types: string, number, boolean → correct toAnyValue mapping", async () => {
    const cfg = makeConfig();
    const { calls, fetchImpl } = captureFetch();

    await emitObservabilityEvent(
      cfg,
      {
        name: "test.all-types",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
        attributes: {
          strAttr: "hello",
          numAttr: 42,
          boolAttr: true,
        },
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    const span = extractSpan(calls);
    const attrs = span.attributes as Array<{ key: string; value: Record<string, unknown> }>;

    const strEntry = attrs.find((a) => a.key === "strAttr");
    expect(strEntry?.value).toEqual({ stringValue: "hello" });

    const numEntry = attrs.find((a) => a.key === "numAttr");
    expect(numEntry?.value).toEqual({ doubleValue: 42 });

    const boolEntry = attrs.find((a) => a.key === "boolAttr");
    expect(boolEntry?.value).toEqual({ boolValue: true });
  });

  test("event with very large durationMs → computeSpanWindow handles correctly", async () => {
    const cfg = makeConfig();
    const { calls, fetchImpl } = captureFetch();
    const largeMs = 999_999_999;

    await emitObservabilityEvent(
      cfg,
      {
        name: "test.large-duration",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
        durationMs: largeMs,
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    const span = extractSpan(calls);
    const startNs = BigInt(span.startTimeUnixNano);
    const endNs = BigInt(span.endTimeUnixNano);
    // End - Start should equal durationMs * 1_000_000 (ns conversion)
    expect(endNs - startNs).toBe(BigInt(largeMs) * 1_000_000n);
    // Start should be >= 0 (Math.max(0, ...) in computeSpanWindow)
    expect(startNs >= 0n).toBe(true);
  });

  test("event with invalid ISO date → computeSpanWindow falls back to Date.now()", async () => {
    const cfg = makeConfig();
    const { calls, fetchImpl } = captureFetch();
    const beforeMs = Date.now();

    await emitObservabilityEvent(
      cfg,
      {
        name: "test.bad-date",
        at: "NOT-A-DATE",
        status: "ok",
        durationMs: 100,
      },
      { fetchImpl }
    );

    const afterMs = Date.now();
    expect(calls).toHaveLength(1);
    const span = extractSpan(calls);
    const endNs = BigInt(span.endTimeUnixNano);
    const endMs = Number(endNs / 1_000_000n);
    // The fallback should produce an endMs within our test's time window
    expect(endMs).toBeGreaterThanOrEqual(beforeMs);
    expect(endMs).toBeLessThanOrEqual(afterMs);
  });
});

describe("emitObservabilityEvent error resilience", () => {
  test("fetch rejects (network error) → should NOT throw", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    // Should resolve without throwing
    await emitObservabilityEvent(
      cfg,
      { name: "test.net-error", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );
  });

  test("fetch returns non-200 → should NOT throw (best-effort)", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as any;

    // Should resolve without throwing
    await emitObservabilityEvent(
      cfg,
      { name: "test.server-error", at: "2026-02-11T18:00:00.000Z", status: "ok" },
      { fetchImpl }
    );
  });
});
