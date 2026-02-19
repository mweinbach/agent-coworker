import { describe, expect, test } from "bun:test";

import type { AgentConfig } from "../src/types";
import { emitObservabilityEvent } from "../src/observability/otel";

function makeConfig(baseUrl: string): AgentConfig {
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
      baseUrl,
      otelEndpoint: `${baseUrl.replace(/\/+$/, "")}/api/public/otel/v1/traces`,
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
    },
    harness: {
      reportOnly: true,
      strictMode: false,
    },
  };
}

describe("emitObservabilityEvent URL and payload details", () => {
  test("normalizes trailing slash on LANGFUSE_BASE_URL", async () => {
    const cfg = makeConfig("https://cloud.langfuse.com/");
    const calls: string[] = [];

    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("", { status: 200 });
    }) as any;

    await emitObservabilityEvent(
      cfg,
      {
        name: "harness.run.started",
        at: "2026-02-11T18:00:00.000Z",
        status: "ok",
      },
      { fetchImpl }
    );

    expect(calls).toEqual(["https://cloud.langfuse.com/api/public/otel/v1/traces"]);
  });

  test("preserves finite numeric and boolean attributes", async () => {
    const cfg = makeConfig("https://self-hosted.langfuse.internal");
    let body: any = null;

    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response("", { status: 200 });
    }) as any;

    await emitObservabilityEvent(
      cfg,
      {
        name: "harness.run.completed",
        at: "2026-02-11T18:00:01.000Z",
        status: "ok",
        durationMs: 123,
        attributes: {
          attempts: 3,
          passed: true,
          runId: "run-42",
        },
      },
      { fetchImpl }
    );

    const attrs = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.attributes ?? [];

    const attemptsAttr = attrs.find((attr: any) => attr.key === "attempts");
    const passedAttr = attrs.find((attr: any) => attr.key === "passed");
    const runIdAttr = attrs.find((attr: any) => attr.key === "runId");

    expect(attemptsAttr?.value?.doubleValue).toBe(3);
    expect(passedAttr?.value?.boolValue).toBe(true);
    expect(runIdAttr?.value?.stringValue).toBe("run-42");
  });

  test("invalid event timestamp falls back to current time window", async () => {
    const cfg = makeConfig("https://cloud.langfuse.com");
    let span: any = null;

    const before = Date.now();
    const fetchImpl: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      span = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0];
      return new Response("", { status: 200 });
    }) as any;

    await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.started",
        at: "NOT-A-DATE",
        status: "ok",
        durationMs: 100,
      },
      { fetchImpl }
    );
    const after = Date.now();

    const endMs = Number(BigInt(span.endTimeUnixNano) / 1_000_000n);
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
  });
});
