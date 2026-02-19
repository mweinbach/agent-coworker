import { describe, expect, test } from "bun:test";

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
    },
    harness: { reportOnly: true, strictMode: false },
    ...overrides,
  };
}

function makeHealth(status: ObservabilityHealth["status"], reason: string): ObservabilityHealth {
  return {
    status,
    reason,
    updatedAt: "2026-02-19T08:00:00.000Z",
  };
}

function makeTracer() {
  const capture = {
    startTime: null as Date | null,
    endTime: null as Date | null,
    attributes: {} as Record<string, unknown>,
  };

  const tracer = {
    startSpan(_name: string, options?: { startTime?: Date; attributes?: Record<string, unknown> }) {
      capture.startTime = options?.startTime ?? null;
      capture.attributes = options?.attributes ?? {};
      return {
        setStatus() {},
        end(time?: Date) {
          capture.endTime = time ?? null;
        },
      };
    },
  };

  return { tracer, capture };
}

describe("emitObservabilityEvent payload details", () => {
  test("invalid event timestamp falls back to current time window", async () => {
    const cfg = makeConfig();
    const { tracer, capture } = makeTracer();
    const ready = makeHealth("ready", "runtime_ready");
    const before = Date.now();

    await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.started",
        at: "NOT-A-DATE",
        status: "ok",
        durationMs: 100,
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

    const after = Date.now();
    const endMs = capture.endTime?.getTime() ?? 0;
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
  });

  test("preserves finite numeric/boolean attributes", async () => {
    const cfg = makeConfig();
    const { tracer, capture } = makeTracer();
    const ready = makeHealth("ready", "runtime_ready");

    await emitObservabilityEvent(
      cfg,
      {
        name: "harness.run.completed",
        at: "2026-02-19T08:00:00.000Z",
        status: "ok",
        attributes: {
          attempts: 3,
          passed: true,
          runId: "run-42",
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

    expect(capture.attributes["attempts"]).toBe(3);
    expect(capture.attributes["passed"]).toBe(true);
    expect(capture.attributes["runId"]).toBe("run-42");
  });

  test("truncates long string attributes", async () => {
    const cfg = makeConfig();
    const { tracer, capture } = makeTracer();
    const ready = makeHealth("ready", "runtime_ready");
    const veryLong = "x".repeat(4000);

    await emitObservabilityEvent(
      cfg,
      {
        name: "agent.turn.completed",
        at: "2026-02-19T08:00:00.000Z",
        status: "ok",
        attributes: {
          message: veryLong,
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

    const message = String(capture.attributes["message"] ?? "");
    expect(message.length).toBeLessThanOrEqual(2048);
  });
});
