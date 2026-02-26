import { afterEach, describe, expect, test } from "bun:test";

import type { AgentConfig } from "../src/types";
import {
  __internal,
  buildRuntimeTelemetrySettings,
  ensureObservabilityRuntime,
  getObservabilityHealth,
  noteObservabilityFailure,
  noteObservabilitySuccess,
} from "../src/observability/runtime";

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
      release: "runtime-test",
    },
    harness: { reportOnly: true, strictMode: false },
    ...overrides,
  };
}

afterEach(async () => {
  await __internal.resetForTests();
});

describe("observability runtime", () => {
  test("enabled observability with missing credentials is degraded and non-ready", async () => {
    const cfg = makeConfig({
      observability: {
        provider: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
        otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
      },
    });

    const runtime = await ensureObservabilityRuntime(cfg);
    expect(runtime.ready).toBe(false);
    expect(runtime.health.status).toBe("degraded");
    expect(runtime.health.reason).toBe("missing_credentials");
  });

  test("runtime initializes when enabled and fully configured", async () => {
    const cfg = makeConfig();
    const runtime = await ensureObservabilityRuntime(cfg);
    expect(runtime.ready).toBe(true);
    expect(runtime.health.status).toBe("ready");

    const snapshot = __internal.getStateSnapshot();
    expect(snapshot.hasSdk).toBe(true);
    expect(snapshot.hasSpanProcessor).toBe(true);
  });

  test("buildRuntimeTelemetrySettings enables full I/O capture", async () => {
    const cfg = makeConfig();
    const telemetry = await buildRuntimeTelemetrySettings(cfg, {
      functionId: "session.turn",
      metadata: {
        sessionId: "session-123",
        runId: "run-001",
      },
    });

    expect(telemetry?.isEnabled).toBe(true);
    expect(telemetry?.recordInputs).toBe(true);
    expect(telemetry?.recordOutputs).toBe(true);
    expect(telemetry?.functionId).toBe("session.turn");
    expect((telemetry?.metadata as any)?.sessionId).toBe("session-123");
    expect((telemetry?.metadata as any)?.provider).toBe("openai");
  });

  test("buildRuntimeTelemetrySettings returns undefined when observability is disabled", async () => {
    const cfg = makeConfig({ observabilityEnabled: false });
    const telemetry = await buildRuntimeTelemetrySettings(cfg, {
      functionId: "session.turn",
    });
    expect(telemetry).toBeUndefined();
  });

  test("noteObservabilityFailure degrades and noteObservabilitySuccess recovers", () => {
    const cfg = makeConfig();
    const before = getObservabilityHealth(cfg);
    expect(before.status).toBe("ready");

    const failed = noteObservabilityFailure("runtime_flush_failed", "timeout");
    expect(failed.health.status).toBe("degraded");
    expect(failed.health.reason).toBe("runtime_flush_failed");

    const recovered = noteObservabilitySuccess(cfg, "runtime_recovered");
    expect(recovered.health.status).toBe("ready");
    expect(recovered.health.reason).toBe("runtime_recovered");
  });
});
