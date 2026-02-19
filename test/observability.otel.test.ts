import { describe, expect, test } from "bun:test";

import type { AgentConfig } from "../src/types";
import { emitObservabilityEvent } from "../src/observability/otel";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
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
      provider: "langfuse",
      baseUrl: "https://cloud.langfuse.com",
      otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      tracingEnvironment: "test",
      release: "test-sha",
    },
    harness: {
      reportOnly: true,
      strictMode: false,
    },
    ...overrides,
  };
}

describe("emitObservabilityEvent (Langfuse)", () => {
  test("does nothing when observability is disabled", async () => {
    const cfg = makeConfig({ observabilityEnabled: false });
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

  test("warns and no-ops when enabled but Langfuse credentials are missing", async () => {
    const cfg = makeConfig({
      observabilityEnabled: true,
      observability: {
        provider: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
        otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
      },
    });

    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("", { status: 200 });
    }) as any;

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(" "));
    };
    try {
      await emitObservabilityEvent(
        cfg,
        {
          name: "agent.turn.started",
          at: "2026-02-11T18:00:00.000Z",
          status: "ok",
        },
        { fetchImpl }
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(calls).toHaveLength(0);
    expect(warnings.some((line) => line.includes("Langfuse telemetry is enabled"))).toBe(true);
  });

  test("emits an OTLP span to Langfuse ingest with Basic auth", async () => {
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
          model: "gpt-5.2",
          promptBody: "this must be filtered",
          error: "this must be filtered",
        },
      },
      { fetchImpl }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");

    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Basic " + Buffer.from("pk-lf-test:sk-lf-test").toString("base64"));

    const body = JSON.parse(String(calls[0]?.init?.body));
    const resourceAttrs = body.resourceSpans?.[0]?.resource?.attributes ?? [];
    expect(resourceAttrs.some((attr: any) => attr.key === "deployment.environment")).toBe(true);

    const span = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
    expect(span?.name).toBe("agent.turn.completed");
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span?.status?.code).toBe(1);

    const attrs = span?.attributes ?? [];
    expect(attrs.some((attr: any) => attr.key === "sessionId")).toBe(true);
    expect(attrs.some((attr: any) => attr.key === "provider")).toBe(true);
    expect(attrs.some((attr: any) => attr.key === "model")).toBe(true);
    expect(attrs.some((attr: any) => attr.key === "duration.ms")).toBe(true);
    expect(attrs.some((attr: any) => attr.key === "promptBody")).toBe(false);
    expect(attrs.some((attr: any) => attr.key === "error")).toBe(false);
  });

  test("marks error spans with OTLP error status code", async () => {
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

  test("fetch failures are swallowed (best-effort export)", async () => {
    const cfg = makeConfig();
    const fetchImpl: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
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
  });
});
