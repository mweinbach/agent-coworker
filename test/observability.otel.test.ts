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

describe("emitObservabilityEvent", () => {
  test("does nothing when observability is disabled", async () => {
    const cfg = { ...makeConfig(), observabilityEnabled: false };
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("", { status: 200 });
    }) as any;

    await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.started",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(0);
  });

  test("emits an OTLP trace span to VictoriaTraces insert endpoint", async () => {
    const cfg = makeConfig();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("", { status: 200 });
    }) as any;

    await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.completed",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
        durationMs: 250,
        attributes: {
          sessionId: "session-123",
          provider: "openai",
        },
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:10428/insert/opentelemetry/v1/traces");

    const body = JSON.parse(String(calls[0]?.init?.body));
    const span = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.name).toBe("agent.turn.completed");
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span?.status?.code).toBe(1);
    expect(Array.isArray(span?.attributes)).toBe(true);
    expect(span?.attributes.some((attr: any) => attr.key === "sessionId")).toBe(true);
    expect(span?.attributes.some((attr: any) => attr.key === "duration.ms")).toBe(true);
  });

  test("marks error spans with error status code", async () => {
    const cfg = makeConfig();
    let payload: any = null;
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body ?? "{}"));
      return new Response("", { status: 200 });
    }) as any;

    await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.failed",
        at: "2026-02-11T18:00:00.000Z",
        status: "error",
      },
      { fetchImpl }
    );

    const span = payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.status?.code).toBe(2);
  });
});
