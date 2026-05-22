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

  describe("setModel", () => {
    test("updates model in-session and emits config_updated", async () => {
      const { session, events } = makeSession();
      await session.setModel("gemini-3-flash-preview");

      expect(session.getPublicConfig().provider).toBe("google");
      expect(session.getPublicConfig().model).toBe("gemini-3-flash-preview");
      const updated = events.find(
        (e): e is Extract<SessionEvent, { type: "config_updated" }> => e.type === "config_updated",
      );
      expect(updated).toBeDefined();
      if (updated) {
        expect(updated.config.provider).toBe("google");
        expect(updated.config.model).toBe("gemini-3-flash-preview");
      }
      expect(events.some((e) => e.type === "error")).toBe(false);
    });

    test("updates provider+model in-session and emits config_updated", async () => {
      const { session, events } = makeSession();
      await session.setModel("claude-sonnet-4-5", "anthropic");

      expect(session.getPublicConfig().provider).toBe("anthropic");
      expect(session.getPublicConfig().model).toBe("claude-sonnet-4-5");
      const updated = events.find(
        (e): e is Extract<SessionEvent, { type: "config_updated" }> => e.type === "config_updated",
      );
      expect(updated).toBeDefined();
      if (updated) {
        expect(updated.config.provider).toBe("anthropic");
        expect(updated.config.model).toBe("claude-sonnet-4-5");
      }
      expect(events.some((e) => e.type === "error")).toBe(false);
    });

    test("normalizes runtime when switching away from openai-family providers", async () => {
      const { session } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session-openai-runtime"),
          provider: "openai",
          runtime: "openai-responses",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      await session.setModel("gemini-3-flash-preview", "google");

      expect((session as any).state.config.provider).toBe("google");
      expect((session as any).state.config.runtime).toBe("google-interactions");
      expect(createRuntime((session as any).state.config).name).toBe("google-interactions");
    });

    test("clears persisted OpenAI continuation state when provider/model changes", async () => {
      const { session } = makeSession();
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_123",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.setModel("gpt-5.2", "openai");

      expect((session as any).state.providerState).toBeNull();
    });

    test("emits session_info when provider/model changes", async () => {
      const { session, events } = makeSession();
      await session.setModel("gpt-5.2", "openai");
      const info = events.find(
        (e): e is Extract<SessionEvent, { type: "session_info" }> => e.type === "session_info",
      );
      expect(info).toBeDefined();
      if (info) {
        expect(info.provider).toBe("openai");
        expect(info.model).toBe("gpt-5.2");
      }
    });

    test("invokes model-selection persistence hook with updated defaults", async () => {
      const persistModelSelectionImpl = mock(async () => {});
      const { session } = makeSession({ persistModelSelectionImpl });

      await session.setModel("gpt-5.2", "openai");

      expect(persistModelSelectionImpl).toHaveBeenCalledTimes(1);
      expect(persistModelSelectionImpl).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.2",
        preferredChildModel: "gpt-5.2",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5.2",
        allowedChildModelRefs: [],
      });
    });

    test("preserves canonical cross-provider child refs when the session provider changes", async () => {
      const persistModelSelectionImpl = mock(async () => {});
      const { session } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "codex-cli",
          model: "gpt-5.4",
          preferredChildModel: "gpt-5-mini",
          childModelRoutingMode: "cross-provider-allowlist",
          preferredChildModelRef: "google:gemini-3.1-pro-preview",
          allowedChildModelRefs: ["google:gemini-3.1-pro-preview"],
        },
        persistModelSelectionImpl,
      });

      await session.setModel("gpt-5.2", "openai");

      const configEvent = session.getSessionConfigEvent();
      expect(configEvent.config.preferredChildModel).toBe("gpt-5-mini");
      expect(configEvent.config.childModelRoutingMode).toBe("cross-provider-allowlist");
      expect(configEvent.config.preferredChildModelRef).toBe("google:gemini-3.1-pro-preview");
      expect(configEvent.config.allowedChildModelRefs).toEqual(["google:gemini-3.1-pro-preview"]);
      expect(persistModelSelectionImpl).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.2",
        preferredChildModel: "gpt-5-mini",
        childModelRoutingMode: "cross-provider-allowlist",
        preferredChildModelRef: "google:gemini-3.1-pro-preview",
        allowedChildModelRefs: ["google:gemini-3.1-pro-preview"],
      });
    });

    test("suppresses no-op model updates when provider and model are unchanged", async () => {
      const persistModelSelectionImpl = mock(async () => {});
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
          knowledgeCutoff: getSupportedModel("openai", "gpt-5.2")?.knowledgeCutoff ?? "unknown",
        },
        persistModelSelectionImpl,
      });

      await session.setModel("gpt-5.2", "openai");

      expect(persistModelSelectionImpl).not.toHaveBeenCalled();
      expect(events.some((evt) => evt.type === "config_updated")).toBe(false);
      expect(events.some((evt) => evt.type === "session_info")).toBe(false);
    });

    test("persistence-hook failures keep model updates and emit a non-fatal error", async () => {
      const persistModelSelectionImpl = mock(async () => {
        throw new Error("disk write failed");
      });
      const { session, events } = makeSession({ persistModelSelectionImpl });

      await session.setModel("gemini-3-flash-preview");

      const updated = events.find(
        (e): e is Extract<SessionEvent, { type: "config_updated" }> => e.type === "config_updated",
      );
      expect(updated).toBeDefined();
      expect(session.getPublicConfig().model).toBe("gemini-3-flash-preview");
      const err = events.find(
        (e): e is Extract<SessionEvent, { type: "error" }> =>
          e.type === "error" && e.message.includes("Model updated for this session"),
      );
      expect(err).toBeDefined();
      if (err) {
        expect(err.code).toBe("internal_error");
      }
    });

    test("empty model emits error and does not change model", async () => {
      const { session, events } = makeSession();
      const before = session.getPublicConfig().model;

      await session.setModel("   ");

      expect(session.getPublicConfig().model).toBe(before);
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Model id is required");
      }
    });

    test("unsupported provider emits error and does not change config", async () => {
      const { session, events } = makeSession();
      const before = session.getPublicConfig();

      await session.setModel("gemini-3-flash-preview", "invalid-provider" as any);

      expect(session.getPublicConfig()).toEqual(before);
      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Unsupported provider");
      }
    });

    test("OpenAI-looking model on anthropic emits actionable provider guidance", async () => {
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session-model-mismatch"),
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          preferredChildModel: "claude-sonnet-4-5",
          knowledgeCutoff:
            getSupportedModel("anthropic", "claude-sonnet-4-5")?.knowledgeCutoff ?? "unknown",
        },
      });
      const before = session.getPublicConfig();

      await session.setModel("gpt-5.4(xhigh)", "anthropic");

      expect(session.getPublicConfig()).toEqual(before);
      const err = events.find(
        (e): e is Extract<SessionEvent, { type: "error" }> => e.type === "error",
      );
      expect(err).toBeDefined();
      if (err) {
        expect(err.code).toBe("validation_failed");
        expect(err.source).toBe("provider");
        expect(err.message).toContain("looks like an OpenAI model");
        expect(err.message).toContain("use provider openai instead");
      }
    });

    test("applySessionDefaults persists combined defaults once and emits one snapshot write", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({
        persistProjectConfigPatchImpl,
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
          enableMcp: true,
        },
      });

      await session.applySessionDefaults({
        provider: "openai",
        model: "gpt-5.2",
        enableMcp: false,
        config: {
          backupsEnabled: true,
          preferredChildModel: "gpt-5-mini",
        },
      });
      await flushAsyncWork();

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.2",
        preferredChildModel: "gpt-5-mini",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5-mini",
        allowedChildModelRefs: [],
        backupsEnabled: true,
        enableMcp: false,
      });

      expect(events.some((evt) => evt.type === "config_updated")).toBe(true);
      expect(events.some((evt) => evt.type === "session_config")).toBe(true);
      expect(events.some((evt) => evt.type === "session_settings")).toBe(true);
    });
  });
});
