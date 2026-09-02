import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RunTurnParams } from "../../src/agent";
import { getAiCoworkerPaths } from "../../src/connect";
import { resolveModelMetadata } from "../../src/models/metadata";
import { upsertCustomModel } from "../../src/providers/customModels";
import type { SessionEvent } from "../../src/server/protocol";
import type { PersistedSessionMutation } from "../../src/server/sessionDb";
import type { PersistedSessionSnapshot } from "../../src/server/sessionStore";
import type { AgentConfig } from "../../src/types";
import { makeTmpProject } from "../helpers/wsHarness";
import type { TodoItem } from "./agentSession.harness";
import {
  AgentSession,
  ASK_SKIP_TOKEN,
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

function createDeferred<T>() {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T | PromiseLike<T>) => {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

async function loadModelTestSystemPrompt() {
  return {
    prompt: "You are a test assistant.",
    discoveredSkills: [],
  };
}

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
      const { session, events } = makeSession({
        loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
      });
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
      const { session, events } = makeSession({
        loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
      });
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

    test("persists same-provider model switches with cleared continuation state before resolving", async () => {
      const mutationGate = createDeferred<number>();
      const persistedMutations: PersistedSessionMutation[] = [];
      let modelMutationStarted = false;
      const sessionDb = {
        persistSessionMutation: mock(async (input: PersistedSessionMutation) => {
          persistedMutations.push(input);
          if (input.eventType !== "session.model_updated") {
            return persistedMutations.length;
          }
          modelMutationStarted = true;
          return await mutationGate.promise;
        }),
        persistSessionSnapshot: mock(async () => {}),
      };
      const { session } = makeSession({ sessionDb: sessionDb as never });
      (session as any).state.providerState = {
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "interaction_flash",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      const setModelPromise = session.setModel("gemini-3.1-pro-preview", "google");
      let resolved = false;
      void setModelPromise.then(() => {
        resolved = true;
      });

      await waitForCondition(() => modelMutationStarted);
      await flushAsyncWork();

      const modelMutation = persistedMutations.find(
        (mutation) => mutation.eventType === "session.model_updated",
      );
      expect(resolved).toBe(false);
      expect(modelMutation?.snapshot.provider).toBe("google");
      expect(modelMutation?.snapshot.model).toBe("gemini-3.1-pro-preview");
      expect(modelMutation?.snapshot.providerState).toBeNull();

      mutationGate.resolve(2);
      await setModelPromise;

      expect(resolved).toBe(true);
      expect(sessionDb.persistSessionSnapshot).toHaveBeenCalledTimes(persistedMutations.length);
    });

    test("follow-up turns use the selected model without stale continuation state", async () => {
      let runTurnParams: RunTurnParams | null = null;
      const runTurnImpl = mock(async (params: RunTurnParams) => {
        runTurnParams = params;
        return {
          text: "response",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "response" }],
        };
      });
      const { session } = makeSession({ runTurnImpl });
      (session as any).state.providerState = {
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "interaction_flash",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.setModel("gemini-3.1-pro-preview", "google");
      await session.sendUserMessage("Use the selected model");

      expect(runTurnParams?.config.provider).toBe("google");
      expect(runTurnParams?.config.model).toBe("gemini-3.1-pro-preview");
      expect(runTurnParams?.providerState).toBeNull();
    });

    test("turns started while a model switch is pending wait for the selected model", async () => {
      let runTurnParams: RunTurnParams | null = null;
      const runTurnImpl = mock(async (params: RunTurnParams) => {
        runTurnParams = params;
        return {
          text: "response",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "response" }],
        };
      });
      const { session } = makeSession({ runTurnImpl });

      const setModelPromise = session.setModel("gemini-3.1-pro-preview", "google");
      const sendPromise = session.sendUserMessage("Send immediately after switching models");

      await Promise.all([setModelPromise, sendPromise]);

      expect(runTurnParams?.config.provider).toBe("google");
      expect(runTurnParams?.config.model).toBe("gemini-3.1-pro-preview");
    });

    test("cached-token usage is attributed to the selected model after switching", async () => {
      const runTurnImpl = mock(async (_params: RunTurnParams) => ({
        text: "response",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "response" }],
        usage: {
          promptTokens: 12,
          completionTokens: 4,
          totalTokens: 16,
          cachedPromptTokens: 5,
          cacheWritePromptTokens: 2,
        },
      }));
      const { session } = makeSession({ runTurnImpl });

      await session.setModel("gemini-3.1-pro-preview", "google");
      await session.sendUserMessage("Track cached tokens on the new model");

      const usage = (session as any).state.costTracker.getSnapshot();
      expect(usage.turns[0]?.provider).toBe("google");
      expect(usage.turns[0]?.model).toBe("gemini-3.1-pro-preview");
      expect(usage.turns[0]?.usage.cachedPromptTokens).toBe(5);
      expect(usage.turns[0]?.usage.cacheWritePromptTokens).toBe(2);
      expect(usage.byModel).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "google",
            model: "gemini-3.1-pro-preview",
            totalCachedPromptTokens: 5,
            totalCacheWritePromptTokens: 2,
          }),
        ]),
      );
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
          providerOptions: {
            openai: { reasoningEffort: "high", reasoningSummary: "detailed" },
          },
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

    test("configured custom model IDs can be selected for dynamic providers", async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-custom-model-"));
      const config: AgentConfig = {
        ...makeConfig(homeDir),
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        preferredChildModel: "claude-sonnet-4-5",
      };
      await upsertCustomModel(
        getAiCoworkerPaths({ homedir: path.dirname(config.userCoworkDir) }),
        "anthropic",
        "claude-custom-20260704",
      );
      const { session, events } = makeSession({
        config,
        loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
      });

      await session.setModel("claude-custom-20260704", "anthropic");

      expect(session.getPublicConfig().provider).toBe("anthropic");
      expect(session.getPublicConfig().model).toBe("claude-custom-20260704");
      expect(events.some((event) => event.type === "error")).toBe(false);
    });

    test("switching to a non-reasoning custom OpenAI model drops stale reasoning options", async () => {
      const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-reasoning-switch-"));
      const config: AgentConfig = {
        ...makeConfig(homeDir),
        provider: "openai",
        model: "gpt-5.4",
        preferredChildModel: "gpt-5.4",
        // Prior reasoning-model selection left these in the config.
        providerOptions: {
          openai: { reasoningEffort: "high", reasoningSummary: "detailed" },
        },
      };
      await upsertCustomModel(
        getAiCoworkerPaths({ homedir: path.dirname(config.userCoworkDir) }),
        "openai",
        "gpt-4o",
      );
      const { session, events } = makeSession({
        config,
        loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
      });

      await session.setModel("gpt-4o", "openai");

      expect(session.getPublicConfig().model).toBe("gpt-4o");
      expect(events.some((event) => event.type === "error")).toBe(false);
      const openaiOptions = session.getSessionConfigEvent().config.providerOptions?.openai as
        | Record<string, unknown>
        | undefined;
      // The stale reasoning options must not survive onto a non-reasoning model.
      expect(openaiOptions?.reasoningEffort).toBeUndefined();
      expect(openaiOptions?.reasoningSummary).toBeUndefined();
    });

    test.each(["setModel", "applySessionDefaults"] as const)(
      "same-model %s persists reasoning cleanup without clearing continuation",
      async (operation) => {
        const dir = await makeTmpProject("session-reasoning-reselect-");
        try {
          const config: AgentConfig = {
            ...makeConfig(dir),
            provider: "openai",
            runtime: "openai-responses",
            model: "gpt-4o",
            preferredChildModel: "gpt-4o",
            childModelRoutingMode: "same-provider",
            preferredChildModelRef: "openai:gpt-4o",
            allowedChildModelRefs: [],
            providerOptions: {
              openai: {
                reasoningEffort: "high",
                reasoningSummary: "detailed",
                serviceTier: "default",
              },
              google: { thinkingConfig: { thinkingLevel: "high" } },
            },
          };
          const home = path.dirname(config.userCoworkDir);
          await upsertCustomModel(getAiCoworkerPaths({ homedir: home }), "openai", "gpt-4o");
          config.knowledgeCutoff = (
            await resolveModelMetadata("openai", "gpt-4o", { home })
          ).knowledgeCutoff;
          const snapshots: PersistedSessionSnapshot[] = [];
          const { session, events } = makeSession({
            config,
            loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
            getProviderCatalogImpl: async () => ({ all: [], default: {}, connected: [] }),
            writePersistedSessionSnapshotImpl: async ({ snapshot }) => {
              snapshots.push(snapshot);
              return path.join(dir, "snapshot.json");
            },
          });
          await session.waitForPersistenceIdle({ throwOnError: true });
          snapshots.length = 0;
          const continuation = {
            provider: "openai",
            model: "gpt-4o",
            responseId: "resp_reselect",
            updatedAt: "2026-02-16T00:00:00.000Z",
          };
          (session as any).state.providerState = continuation;
          const reselect = async () => {
            if (operation === "setModel") {
              await session.setModel("gpt-4o", "openai");
            } else {
              await session.applySessionDefaults({ provider: "openai", model: "gpt-4o" });
            }
            await session.waitForPersistenceIdle({ throwOnError: true });
          };

          await reselect();

          const expectedOptions = {
            openai: { serviceTier: "default" },
            google: { thinkingConfig: { thinkingLevel: "high" } },
          };
          expect((session as any).state.config.providerOptions).toEqual(expectedOptions);
          expect(snapshots.length).toBeGreaterThan(0);
          for (const snapshot of snapshots) {
            expect(snapshot.config.providerOptions).toEqual(expectedOptions);
            expect(snapshot.context.providerState).toEqual(continuation);
          }
          expect((session as any).state.providerState).toBe(continuation);

          const writeCount = snapshots.length;
          events.length = 0;
          await reselect();

          expect(snapshots).toHaveLength(writeCount);
          expect(events.some((event) => event.type === "config_updated")).toBe(false);
          expect(events.some((event) => event.type === "error")).toBe(false);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      },
    );

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

    test("applySessionDefaults preserves runtime settings when persistence fails", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {
        throw new Error("settings storage unavailable");
      });
      const getProviderCatalogImpl = mock(async () => ({
        all: [],
        default: {},
        connected: [],
      }));
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          observabilityEnabled: false,
          backupsEnabled: false,
          enableMcp: true,
        },
        persistProjectConfigPatchImpl,
        getProviderCatalogImpl,
        loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
      });
      const beforePublicConfig = session.getPublicConfig();
      const beforeSessionConfig = session.getSessionConfigEvent().config;
      events.length = 0;

      await session.applySessionDefaults({
        provider: "openai",
        model: "gpt-5.2",
        enableMcp: false,
        config: { observabilityEnabled: true, backupsEnabled: true },
      });

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(getProviderCatalogImpl).not.toHaveBeenCalled();
      expect(session.getPublicConfig()).toEqual(beforePublicConfig);
      expect(session.getSessionConfigEvent().config).toEqual(beforeSessionConfig);
      expect(session.getEnableMcp()).toBe(true);
      expect(events.filter((event) => event.type === "error")).toEqual([
        expect.objectContaining({
          code: "internal_error",
          source: "session",
          message: expect.stringContaining("settings storage unavailable"),
        }),
      ]);
      expect(
        events.some(
          (event) =>
            event.type === "config_updated" ||
            event.type === "session_config" ||
            event.type === "session_settings",
        ),
      ).toBe(false);
    });

    test("applySessionDefaults persists combined defaults once without partial snapshots", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const catalogStarted = createDeferred<void>();
      const catalogGate = createDeferred<void>();
      const mutations: PersistedSessionMutation[] = [];
      let lastEventSeq = 0;
      const sessionDb = {
        persistSessionMutation: mock(async (input: PersistedSessionMutation) => {
          mutations.push(input);
          return ++lastEventSeq;
        }),
        persistSessionSnapshot: mock(async () => {}),
      };
      const { session, events } = makeSession({
        persistProjectConfigPatchImpl,
        sessionDb: sessionDb as never,
        getProviderCatalogImpl: async () => {
          catalogStarted.resolve();
          await catalogGate.promise;
          return { all: [], default: {}, connected: [] };
        },
        loadSystemPromptWithSkillsImpl: loadModelTestSystemPrompt,
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
          enableMcp: true,
        },
      });
      await session.waitForPersistenceIdle({ throwOnError: true });
      mutations.length = 0;
      sessionDb.persistSessionSnapshot.mockClear();

      const applyDefaults = session.applySessionDefaults({
        provider: "openai",
        model: "gpt-5.2",
        enableMcp: false,
        config: {
          backupsEnabled: true,
          preferredChildModel: "gpt-5-mini",
          providerOptions: { openai: { reasoningEffort: "high" } },
        },
      });
      try {
        await catalogStarted.promise;
        await session.waitForPersistenceIdle({ throwOnError: true });
        expect(mutations).toEqual([]);
      } finally {
        catalogGate.resolve();
        await applyDefaults;
        await session.waitForPersistenceIdle({ throwOnError: true });
      }

      expect(
        mutations.filter((mutation) => mutation.eventType === "session.defaults_applied"),
      ).toHaveLength(1);
      for (const mutation of mutations) {
        expect(mutation.snapshot).toMatchObject({
          provider: "openai",
          model: "gpt-5.2",
          enableMcp: false,
          providerOptions: { openai: { reasoningEffort: "high" } },
        });
      }
      expect(sessionDb.persistSessionSnapshot).toHaveBeenCalledTimes(mutations.length);

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-5.2",
        preferredChildModel: "gpt-5-mini",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5-mini",
        allowedChildModelRefs: [],
        backupsEnabled: true,
        providerOptions: { openai: { reasoningEffort: "high" } },
        enableMcp: false,
      });

      expect(events.some((evt) => evt.type === "config_updated")).toBe(true);
      expect(events.some((evt) => evt.type === "session_config")).toBe(true);
      expect(events.some((evt) => evt.type === "session_settings")).toBe(true);
    });

    test("applySessionDefaults persists an unchanged model with dependent defaults", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const model = "gemini-3-flash-preview";
      const { session } = makeSession({
        persistProjectConfigPatchImpl,
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "google",
          model,
          preferredChildModel: model,
          childModelRoutingMode: "same-provider",
          preferredChildModelRef: `google:${model}`,
          allowedChildModelRefs: [],
          knowledgeCutoff: getSupportedModel("google", model)?.knowledgeCutoff ?? "unknown",
          backupsEnabled: false,
        },
      });

      await session.applySessionDefaults({
        provider: "google",
        model,
        config: { backupsEnabled: true },
      });

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        provider: "google",
        model,
        preferredChildModel: model,
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: `google:${model}`,
        allowedChildModelRefs: [],
        backupsEnabled: true,
      });
    });
  });
});
