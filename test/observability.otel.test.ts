import { describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";

import type { AgentConfig, ObservabilityHealth } from "../src/types";
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
    observabilityEnabled: true,
    observability: {
      provider: "langfuse",
      baseUrl: "https://cloud.langfuse.com",
      otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      tracingEnvironment: "test",
      release: "test-release",
    },
    harness: { reportOnly: true, strictMode: false },
    ...overrides,
  };
}

function makeHealth(status: ObservabilityHealth["status"], reason: string, message?: string): ObservabilityHealth {
  return {
    status,
    reason,
    ...(message ? { message } : {}),
    updatedAt: "2026-02-19T08:00:00.000Z",
  };
}

function makeTracer() {
  const captured = {
    name: "",
    startTime: null as Date | null,
    attributes: {} as Record<string, unknown>,
    statusCode: null as number | null,
    endTime: null as Date | null,
    calls: 0,
  };

  const tracer = {
    startSpan(name: string, options?: { startTime?: Date; attributes?: Record<string, unknown> }) {
      captured.calls += 1;
      captured.name = name;
      captured.startTime = options?.startTime ?? null;
      captured.attributes = options?.attributes ?? {};

      return {
        setStatus(status: { code: number }) {
          captured.statusCode = status.code;
        },
        end(time?: Date) {
          captured.endTime = time ?? null;
        },
      };
    },
  };

  return { tracer, captured };
}

describe("emitObservabilityEvent (Langfuse runtime tracer)", () => {
  test("does not emit when runtime is not ready", async () => {
    const cfg = makeConfig();
    const { tracer, captured } = makeTracer();
    const degraded = makeHealth("degraded", "missing_credentials");

    const res = await emitObservabilityEvent(
      cfg,
      { name: "agent.turn.started", at: "2026-02-19T08:00:00.000Z", status: "ok" },
      {
        tracer: tracer as any,
        runtime: {
          ensure: async () => ({ ready: false, health: degraded, healthChanged: false }),
          getHealth: () => degraded,
          noteFailure: () => ({ changed: false, health: degraded }),
          noteSuccess: () => ({ changed: false, health: degraded }),
          forceFlush: async () => {},
        },
      }
    );

    expect(res.emitted).toBe(false);
    expect(res.health.status).toBe("degraded");
    expect(captured.calls).toBe(0);
  });

  test("emits span and keeps diagnostic attributes while redacting secrets", async () => {
    const cfg = makeConfig();
    const { tracer, captured } = makeTracer();
    const ready = makeHealth("ready", "runtime_ready");

    const res = await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.failed",
        at: "2026-02-19T08:00:00.000Z",
        status: "error",
        durationMs: 250,
        attributes: {
          sessionId: "session-123",
          error: "request failed",
          message: "upstream timeout",
          apiKey: "sk-test-secret",
        },
      },
      {
        tracer: tracer as any,
        runtime: {
          ensure: async () => ({ ready: true, health: ready, healthChanged: false }),
          getHealth: () => ready,
          noteFailure: () => ({ changed: false, health: ready }),
          noteSuccess: () => ({ changed: false, health: ready }),
          forceFlush: async () => {},
        },
      }
    );

    expect(res.emitted).toBe(true);
    expect(captured.name).toBe("agent.turn.failed");
    expect(captured.attributes["sessionId"]).toBe("session-123");
    expect(captured.attributes["error"]).toBe("request failed");
    expect(captured.attributes["message"]).toBe("upstream timeout");
    expect(captured.attributes["apiKey"]).toBe("[REDACTED]");
    expect(captured.attributes["duration.ms"]).toBe(250);
    expect(captured.statusCode).toBe(SpanStatusCode.ERROR);
  });

  test("redacts all secret-like attribute keys", async () => {
    const cfg = makeConfig();
    const { tracer, captured } = makeTracer();
    const ready = makeHealth("ready", "runtime_ready");

    const res = await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.completed",
        at: "2026-02-19T08:00:00.000Z",
        status: "ok",
        attributes: {
          apiKey: "sk-xxx",
          api_key: "sk-yyy",
          mySecret: "s3cr3t",
          accessToken: "tok-123",
          authorization: "Bearer xxx",
          sessionCookie: "session=abc",
          userPassword: "hunter2",
          privateKey: "-----BEGIN",
          secretKey: "sk-abc",
          normalField: "visible",
          sessionId: "sess-456",
        },
      },
      {
        tracer: tracer as any,
        runtime: {
          ensure: async () => ({ ready: true, health: ready, healthChanged: false }),
          getHealth: () => ready,
          noteFailure: () => ({ changed: false, health: ready }),
          noteSuccess: () => ({ changed: false, health: ready }),
          forceFlush: async () => {},
        },
      }
    );

    expect(res.emitted).toBe(true);

    // All secret-like keys should be redacted
    expect(captured.attributes["apiKey"]).toBe("[REDACTED]");
    expect(captured.attributes["api_key"]).toBe("[REDACTED]");
    expect(captured.attributes["mySecret"]).toBe("[REDACTED]");
    expect(captured.attributes["accessToken"]).toBe("[REDACTED]");
    expect(captured.attributes["authorization"]).toBe("[REDACTED]");
    expect(captured.attributes["sessionCookie"]).toBe("[REDACTED]");
    expect(captured.attributes["userPassword"]).toBe("[REDACTED]");
    expect(captured.attributes["privateKey"]).toBe("[REDACTED]");
    expect(captured.attributes["secretKey"]).toBe("[REDACTED]");

    // Non-secret keys should be preserved
    expect(captured.attributes["normalField"]).toBe("visible");
    expect(captured.attributes["sessionId"]).toBe("sess-456");
  });

  test("sets OK span status for successful events", async () => {
    const cfg = makeConfig();
    const { tracer, captured } = makeTracer();
    const ready = makeHealth("ready", "runtime_ready");

    await emitObservabilityEvent(
      cfg,
      { name: "agent.turn.completed", at: "2026-02-19T08:00:00.000Z", status: "ok" },
      {
        tracer: tracer as any,
        runtime: {
          ensure: async () => ({ ready: true, health: ready, healthChanged: false }),
          getHealth: () => ready,
          noteFailure: () => ({ changed: false, health: ready }),
          noteSuccess: () => ({ changed: false, health: ready }),
          forceFlush: async () => {},
        },
      }
    );

    expect(captured.statusCode).toBe(SpanStatusCode.OK);
  });

  test("flush failures mark health as degraded and report transition", async () => {
    const cfg = makeConfig();
    const { tracer } = makeTracer();

    let health = makeHealth("ready", "runtime_ready");
    const getHealth = () => health;

    const res = await emitObservabilityEvent(
      cfg,
      { name: "agent.turn.completed", at: "2026-02-19T08:00:00.000Z", status: "ok" },
      {
        tracer: tracer as any,
        runtime: {
          ensure: async () => ({ ready: true, health, healthChanged: false }),
          getHealth,
          noteFailure: (reason, message) => {
            health = makeHealth("degraded", reason, message);
            return { changed: true, health };
          },
          noteSuccess: () => ({ changed: false, health }),
          forceFlush: async () => {
            throw new Error("ECONNRESET");
          },
        },
      }
    );

    expect(res.emitted).toBe(true);
    expect(res.health.status).toBe("degraded");
    expect(res.health.reason).toBe("runtime_flush_failed");
    expect(res.healthChanged).toBe(true);
  });
});
