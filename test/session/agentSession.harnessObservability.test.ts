import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
  createExperimentalA2uiSurfaceManager,
  createRuntime,
  defaultSupportedModel,
  flushAsyncWork,
  fs,
  getSupportedModel,
  isRecord,
  MAX_ATTACHMENT_BASE64_SIZE,
  MAX_ATTACHMENT_INLINE_BYTE_SIZE,
  MAX_TURN_ATTACHMENT_COUNT,
  MAX_TURN_ATTACHMENT_TOTAL_BASE64_SIZE,
  makeConfig,
  makeEmit,
  makeSession,
  makeSessionBackupFactory,
  mockClosePooledCodexAppServerClient,
  mockConnectModelProvider,
  mockGenerateSessionTitle,
  mockGetAiCoworkerPaths,
  mockRunTurn,
  mockWritePersistedSessionSnapshot,
  os,
  path,
  REAL_AGENT,
  resetAgentSessionMocks,
  SessionCostTracker,
  waitForCondition,
  withEnv,
} from "./agentSession.harness";

describe("AgentSession", () => {
  beforeEach(async () => {
    await resetAgentSessionMocks();
  });

  afterAll(() => {
    mock.module("../../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  describe("harness/observability", () => {
    test("getObservabilityStatusEvent reflects config", () => {
      const dir = "/tmp/test-session";
      const cfg: AgentConfig = {
        ...makeConfig(dir),
        observabilityEnabled: true,
        observability: {
          provider: "langfuse",
          baseUrl: "https://cloud.langfuse.com",
          otelEndpoint: "https://cloud.langfuse.com/api/public/otel/v1/traces",
          publicKey: "pk-lf-123",
          secretKey: "sk-lf-123",
          tracingEnvironment: "dev",
          release: "abc123",
        },
      };
      const { session } = makeSession({ config: cfg });
      const evt = session.getObservabilityStatusEvent();
      expect(evt.type).toBe("observability_status");
      expect(evt.enabled).toBe(true);
      expect(evt.health).toBeDefined();
      expect(["disabled", "ready", "degraded"]).toContain(evt.health.status);
      expect(evt.config?.provider).toBe("langfuse");
      expect(evt.config?.baseUrl).toBe("https://cloud.langfuse.com");
      expect(evt.config?.otelEndpoint).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
      expect(evt.config?.hasPublicKey).toBe(true);
      expect(evt.config?.hasSecretKey).toBe(true);
      expect(evt.config?.configured).toBe(true);
      expect((evt.config as any)?.publicKey).toBeUndefined();
      expect((evt.config as any)?.secretKey).toBeUndefined();
    });

    test("setHarnessContext + getHarnessContext emit harness_context", () => {
      const { session, events } = makeSession();
      session.setHarnessContext({
        runId: "run-01",
        objective: "Improve startup reliability",
        acceptanceCriteria: ["startup < 800ms"],
        constraints: ["no API changes"],
      });
      session.getHarnessContext();

      const emitted = events.filter((evt) => evt.type === "harness_context") as any[];
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted.at(-1)?.context?.runId).toBe("run-01");
    });
  });
});
