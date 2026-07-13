import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __internal,
  buildRuntimeTelemetrySettings,
  ensureObservabilityRuntime,
  getObservabilityHealth,
  noteObservabilityFailure,
  noteObservabilitySuccess,
} from "../src/observability/runtime";
import type { AgentConfig } from "../src/types";

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    provider: "openai",
    model: "gpt-5.2",
    preferredChildModel: "gpt-5.2",
    workingDirectory: "/tmp/work",
    outputDirectory: "/tmp/out",
    uploadsDirectory: "/tmp/uploads",
    userName: "",
    knowledgeCutoff: "unknown",
    projectCoworkDir: "/tmp/work/.cowork",
    userCoworkDir: "/tmp/home/.cowork",
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
  delete process.env.COWORK_DISABLE_NETWORK_TELEMETRY;
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
    const realWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      const runtime = await ensureObservabilityRuntime(cfg);
      expect(runtime.ready).toBe(false);
      expect(runtime.health.status).toBe("degraded");
      expect(runtime.health.reason).toBe("missing_credentials");
    } finally {
      console.warn = realWarn;
    }
  });

  test("runtime initializes when enabled and fully configured", async () => {
    const cfg = makeConfig();
    const start = mock(() => {});
    const shutdown = mock(async () => {});
    const forceFlush = mock(async () => {});
    __internal.setRuntimeFactoryForTests(async () => ({
      sdk: { start, shutdown },
      spanProcessor: { forceFlush },
    }));

    const runtime = await ensureObservabilityRuntime(cfg);
    expect(runtime.ready).toBe(true);
    expect(runtime.health.status).toBe("ready");
    expect(runtime.healthChanged).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);

    const snapshot = __internal.getStateSnapshot();
    expect(snapshot.hasSdk).toBe(true);
    expect(snapshot.hasSpanProcessor).toBe(true);
  });

  test("only the initialization owner reports a health change to concurrent callers", async () => {
    const cfg = makeConfig();
    let releaseStart: (() => void) | undefined;
    let markStartEntered: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    __internal.setRuntimeFactoryForTests(async () => ({
      sdk: {
        start: async () => {
          markStartEntered?.();
          await startGate;
        },
        shutdown: async () => {},
      },
      spanProcessor: { forceFlush: async () => {} },
    }));

    try {
      const ownerPromise = ensureObservabilityRuntime(cfg);
      await startEntered;
      const joinerPromise = ensureObservabilityRuntime(cfg);
      releaseStart?.();
      const [owner, joiner] = await Promise.all([ownerPromise, joinerPromise]);

      expect(owner.ready).toBe(true);
      expect(owner.healthChanged).toBe(true);
      expect(joiner.ready).toBe(true);
      expect(joiner.healthChanged).toBe(false);
    } finally {
      releaseStart?.();
    }
  });

  test("runtime initialization is bounded and stale completion cannot reattach after disable", async () => {
    const cfg = makeConfig();
    let releaseStart: (() => void) | undefined;
    let markStartEntered: (() => void) | undefined;
    let markStaleShutdown: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startEntered = new Promise<void>((resolve) => {
      markStartEntered = resolve;
    });
    const staleShutdown = new Promise<void>((resolve) => {
      markStaleShutdown = resolve;
    });
    __internal.setRuntimeInitializationTimeoutForTests(10);
    __internal.setRuntimeFactoryForTests(async () => ({
      sdk: {
        start: async () => {
          markStartEntered?.();
          await startGate;
        },
        shutdown: async () => {
          markStaleShutdown?.();
        },
      },
      spanProcessor: { forceFlush: async () => {} },
    }));
    const realWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      const runtimePromise = ensureObservabilityRuntime(cfg);
      await startEntered;
      const runtime = await runtimePromise;
      expect(runtime.ready).toBe(false);
      expect(runtime.health.reason).toBe("runtime_init_timeout");
      expect(runtime.healthChanged).toBe(true);

      const repeated = await ensureObservabilityRuntime(cfg);
      expect(repeated.health.reason).toBe("runtime_init_timeout");
      expect(repeated.healthChanged).toBe(false);

      const disabled = await ensureObservabilityRuntime({ ...cfg, observabilityEnabled: false });
      expect(disabled.health.status).toBe("disabled");
      releaseStart?.();
      await staleShutdown;
      const snapshot = __internal.getStateSnapshot();
      expect(snapshot.hasSdk).toBe(false);
      expect(snapshot.hasSpanProcessor).toBe(false);
      expect(snapshot.health.status).toBe("disabled");
    } finally {
      releaseStart?.();
      console.warn = realWarn;
    }
  });

  test("buildRuntimeTelemetrySettings is metadata-only by default", async () => {
    const cfg = makeConfig();
    __internal.setEnsureObservabilityRuntimeForTests(async () => ({
      ready: true,
      health: { status: "ready", reason: "runtime_ready", updatedAt: new Date(0).toISOString() },
      healthChanged: false,
    }));
    const telemetry = await buildRuntimeTelemetrySettings(cfg, {
      functionId: "session.turn",
      metadata: {
        sessionId: "session-123",
        runId: "run-001",
      },
    });

    expect(telemetry?.isEnabled).toBe(true);
    expect(telemetry?.recordInputs).toBe(false);
    expect(telemetry?.recordOutputs).toBe(false);
    expect(telemetry?.functionId).toBe("session.turn");
    expect((telemetry?.metadata as any)?.sessionId).toBe("session-123");
    expect((telemetry?.metadata as any)?.provider).toBe("openai");
  });

  test("buildRuntimeTelemetrySettings enables full I/O only when configured", async () => {
    const cfg = makeConfig({
      observability: {
        provider: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
        otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
        publicKey: "pk-lf-test",
        secretKey: "sk-lf-test",
        tracingEnvironment: "test",
        release: "runtime-test",
        recordInputs: true,
        recordOutputs: true,
      },
    });
    __internal.setEnsureObservabilityRuntimeForTests(async () => ({
      ready: true,
      health: { status: "ready", reason: "runtime_ready", updatedAt: new Date(0).toISOString() },
      healthChanged: false,
    }));
    const telemetry = await buildRuntimeTelemetrySettings(cfg, {
      functionId: "session.turn",
    });

    expect(telemetry?.isEnabled).toBe(true);
    expect(telemetry?.recordInputs).toBe(true);
    expect(telemetry?.recordOutputs).toBe(true);
  });

  test("buildRuntimeTelemetrySettings returns undefined when observability is disabled", async () => {
    const cfg = makeConfig({ observabilityEnabled: false });
    const telemetry = await buildRuntimeTelemetrySettings(cfg, {
      functionId: "session.turn",
    });
    expect(telemetry).toBeUndefined();
  });

  test("global kill switch disables Langfuse runtime before SDK initialization", async () => {
    process.env.COWORK_DISABLE_NETWORK_TELEMETRY = "1";
    const cfg = makeConfig();
    const runtime = await ensureObservabilityRuntime(cfg);

    expect(runtime.ready).toBe(false);
    expect(runtime.health.status).toBe("disabled");
    expect(runtime.health.reason).toBe("network_telemetry_disabled");
    expect(__internal.getStateSnapshot().hasSdk).toBe(false);
    expect(__internal.getStateSnapshot().hasSpanProcessor).toBe(false);
  });

  test("noteObservabilityFailure degrades and noteObservabilitySuccess recovers", () => {
    const cfg = makeConfig();
    const before = getObservabilityHealth(cfg);
    expect(before.status).toBe("ready");
    const realWarn = console.warn;
    console.warn = mock(() => {}) as typeof console.warn;

    try {
      const failed = noteObservabilityFailure("runtime_flush_failed", "timeout");
      expect(failed.health.status).toBe("degraded");
      expect(failed.health.reason).toBe("runtime_flush_failed");

      const recovered = noteObservabilitySuccess(cfg, "runtime_recovered");
      expect(recovered.health.status).toBe("ready");
      expect(recovered.health.reason).toBe("runtime_recovered");
    } finally {
      console.warn = realWarn;
    }
  });
});
