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

  describe("enableMcp settings", () => {
    test("getEnableMcp reflects config.enableMcp", () => {
      const dir = "/tmp/test-session";
      const cfg = { ...makeConfig(dir), enableMcp: false };
      const { session } = makeSession({ config: cfg });
      expect(session.getEnableMcp()).toBe(false);
    });

    test("setEnableMcp updates config and emits session_settings", async () => {
      const dir = "/tmp/test-session";
      const cfg = { ...makeConfig(dir), enableMcp: true };
      const { session, events } = makeSession({ config: cfg });

      await session.setEnableMcp(false);

      expect(session.getEnableMcp()).toBe(false);
      const evt = events.find((e) => e.type === "session_settings") as any;
      expect(evt).toBeDefined();
      expect(evt.enableMcp).toBe(false);
    });

    test("setEnableMcp persists workspace defaults via patch hook", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session } = makeSession({ persistProjectConfigPatchImpl });

      await session.setEnableMcp(false);

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({ enableMcp: false });
    });

    test("setEnableMcp suppresses no-op writes when the value is unchanged", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({
        config: { ...makeConfig("/tmp/test-session"), enableMcp: true },
        persistProjectConfigPatchImpl,
      });

      await session.setEnableMcp(true);

      expect(persistProjectConfigPatchImpl).not.toHaveBeenCalled();
      expect(events.some((evt) => evt.type === "session_settings")).toBe(false);
    });

    test("setEnableMcp persistence failures still apply runtime state and emit a non-fatal error", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {
        throw new Error("write failed");
      });
      const { session, events } = makeSession({ persistProjectConfigPatchImpl });

      await session.setEnableMcp(false);

      expect(session.getEnableMcp()).toBe(false);
      expect(events.some((evt) => evt.type === "session_settings")).toBe(true);
      const errEvt = events.find(
        (evt): evt is Extract<SessionEvent, { type: "error" }> => evt.type === "error",
      );
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("internal_error");
        expect(errEvt.message).toContain("MCP setting updated for this session");
      }
    });

    test("setEnableMcp while running emits Agent is busy", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      await session.setEnableMcp(false);
      const errEvt = events.find((e) => e.type === "error") as any;
      expect(errEvt).toBeDefined();
      expect(errEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;
    });
  });

  describe("memory settings", () => {
    test("sendUserMessage skips prompt reload when cached metadata has zero discovered skills", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => {
        throw new Error("should not reload");
      });
      const { session } = makeSession({
        system: "prompt:root-system",
        loadSystemPromptWithSkillsImpl,
        discoveredSkills: [],
      });

      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).not.toHaveBeenCalled();

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:root-system");
      expect(runTurnArgs.discoveredSkills).toEqual([]);
    });

    test("sendUserMessage refreshes the prompt when the skill catalog mtime changes", async () => {
      const readSkillCatalogMtimeSnapshotImpl = mock(async () => "snapshot:new");
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:skills-refreshed",
        discoveredSkills: [{ name: "fresh-skill", description: "Fresh skill" }],
      }));
      const { session } = makeSession({
        system: "prompt:stale",
        discoveredSkills: [{ name: "stale-skill", description: "Stale skill" }],
        initialSkillCatalogMtimeSnapshot: "snapshot:old",
        readSkillCatalogMtimeSnapshotImpl,
        loadSystemPromptWithSkillsImpl,
      });

      await session.sendUserMessage("hello");

      expect(readSkillCatalogMtimeSnapshotImpl).toHaveBeenCalledTimes(2);
      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:skills-refreshed");
      expect(runTurnArgs.discoveredSkills).toEqual([
        { name: "fresh-skill", description: "Fresh skill" },
      ]);
    });

    test("sendUserMessage records the skill catalog mtime without refreshing on first observation", async () => {
      const readSkillCatalogMtimeSnapshotImpl = mock(async () => "snapshot:current");
      const loadSystemPromptWithSkillsImpl = mock(async () => {
        throw new Error("should not reload");
      });
      const { session } = makeSession({
        system: "prompt:cached",
        discoveredSkills: [{ name: "cached-skill", description: "Cached skill" }],
        readSkillCatalogMtimeSnapshotImpl,
        loadSystemPromptWithSkillsImpl,
      });

      await session.sendUserMessage("hello");

      expect(readSkillCatalogMtimeSnapshotImpl).toHaveBeenCalledTimes(1);
      expect(loadSystemPromptWithSkillsImpl).not.toHaveBeenCalled();

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:cached");
    });

    test("sendUserMessage backfills discovered skills when prompt metadata is missing", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:root-system",
        discoveredSkills: [{ name: "delegated-skill", description: "Delegated skill" }],
      }));
      const { session } = makeSession({
        system: "prompt:child-system",
        loadSystemPromptWithSkillsImpl,
        discoveredSkills: undefined,
      });

      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:child-system");
      expect(runTurnArgs.discoveredSkills).toEqual([
        { name: "delegated-skill", description: "Delegated skill" },
      ]);
    });

    test("setConfig refreshes the cached system prompt when enableMemory changes", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const loadSystemPromptWithSkillsImpl = mock(async (config: AgentConfig) => ({
        prompt: `prompt:memory-${String(config.enableMemory ?? true)}`,
        discoveredSkills: [{ name: "memory-skill", description: "Memory skill" }],
      }));
      const { session } = makeSession({
        persistProjectConfigPatchImpl,
        loadSystemPromptWithSkillsImpl,
        system: "prompt:memory-true",
      });

      await session.setConfig({ enableMemory: false });
      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({ enableMemory: false });

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:memory-false");
      expect(runTurnArgs.discoveredSkills).toEqual([
        { name: "memory-skill", description: "Memory skill" },
      ]);
    });

    test("setConfig refreshes the cached system prompt when the A2UI feature flag changes", async () => {
      await withEnv("COWORK_EXPERIMENTAL_A2UI", "1", async () => {
        const persistProjectConfigPatchImpl = mock(async () => {});
        const loadSystemPromptWithSkillsImpl = mock(async (config: AgentConfig) => ({
          prompt: `prompt:a2ui-${String(config.enableA2ui ?? false)}`,
          discoveredSkills: [{ name: "ui-skill", description: "UI skill" }],
        }));
        const { session } = makeSession({
          persistProjectConfigPatchImpl,
          loadSystemPromptWithSkillsImpl,
          system: "prompt:a2ui-false",
        });

        await session.setConfig({
          featureFlags: {
            workspace: {
              a2ui: true,
            },
          },
        });
        await session.sendUserMessage("hello");

        expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
        expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
          featureFlags: {
            workspace: {
              a2ui: true,
            },
          },
        });

        const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
        expect(runTurnArgs.system).toBe("prompt:a2ui-true");
        expect(runTurnArgs.discoveredSkills).toEqual([
          { name: "ui-skill", description: "UI skill" },
        ]);
        expect(session.getSessionConfigEvent().config.enableA2ui).toBe(true);
      });
    });

    test("upsertMemory refreshes the cached system prompt for later turns", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:memory-updated",
        discoveredSkills: [{ name: "memory-skill", description: "Memory skill" }],
      }));
      const { session, events } = makeSession({
        loadSystemPromptWithSkillsImpl,
        system: "prompt:stale",
      });

      const memoryStore = (session as any).memoryStore;
      memoryStore.upsert = mock(async () => ({
        id: "note",
        scope: "workspace",
        content: "Remember this",
        createdAt: "2026-03-13T00:00:00.000Z",
        updatedAt: "2026-03-13T00:00:00.000Z",
      }));
      memoryStore.list = mock(async () => []);

      await session.upsertMemory("workspace", "note", "Remember this");
      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
      expect(events.some((evt) => evt.type === "memory_list")).toBe(true);

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:memory-updated");
    });

    test("deleteMemory refreshes the cached system prompt for later turns", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:memory-deleted",
        discoveredSkills: [{ name: "memory-skill", description: "Memory skill" }],
      }));
      const { session, events } = makeSession({
        loadSystemPromptWithSkillsImpl,
        system: "prompt:stale",
      });

      const memoryStore = (session as any).memoryStore;
      memoryStore.remove = mock(async () => true);
      memoryStore.list = mock(async () => []);

      await session.deleteMemory("workspace", "note");
      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
      expect(events.some((evt) => evt.type === "memory_list")).toBe(true);

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:memory-deleted");
    });

    test("upsertMemory emits a structured error when the memory store write fails", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:unused",
        discoveredSkills: [],
      }));
      const { session, events } = makeSession({ loadSystemPromptWithSkillsImpl });

      const memoryStore = (session as any).memoryStore;
      memoryStore.upsert = mock(async () => {
        throw new Error("db write failed");
      });

      await session.upsertMemory("workspace", "note", "Remember this");

      expect(loadSystemPromptWithSkillsImpl).not.toHaveBeenCalled();
      const errEvt = events.find(
        (evt): evt is Extract<SessionEvent, { type: "error" }> => evt.type === "error",
      );
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("internal_error");
        expect(errEvt.source).toBe("session");
        expect(errEvt.message).toContain("Failed to upsert memory: Error: db write failed");
      }
    });

    test("deleteMemory emits a structured error when the memory store delete fails", async () => {
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:unused",
        discoveredSkills: [],
      }));
      const { session, events } = makeSession({ loadSystemPromptWithSkillsImpl });

      const memoryStore = (session as any).memoryStore;
      memoryStore.remove = mock(async () => {
        throw new Error("db delete failed");
      });

      await session.deleteMemory("workspace", "note");

      expect(loadSystemPromptWithSkillsImpl).not.toHaveBeenCalled();
      const errEvt = events.find(
        (evt): evt is Extract<SessionEvent, { type: "error" }> => evt.type === "error",
      );
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("internal_error");
        expect(errEvt.source).toBe("session");
        expect(errEvt.message).toContain("Failed to delete memory: Error: db delete failed");
      }
    });
  });

  describe("session config", () => {
    test("getSessionConfigEvent exposes initial runtime session config", () => {
      const { session } = makeSession();
      const evt = session.getSessionConfigEvent();
      expect(evt.type).toBe("session_config");
      expect(evt.config.yolo).toBe(false);
      expect(evt.config.observabilityEnabled).toBe(false);
      expect(evt.config.backupsEnabled).toBe(false);
      expect(evt.config.defaultBackupsEnabled).toBe(false);
      expect(evt.config.enableA2ui).toBeUndefined();
      expect(evt.config.toolOutputOverflowChars).toBe(25000);
      expect("defaultToolOutputOverflowChars" in evt.config).toBe(false);
      expect(evt.config.preferredChildModel).toBe("gemini-3-flash-preview");
      expect(evt.config.maxSteps).toBe(100);
    });

    test("getSessionConfigEvent exposes editable openai-compatible provider options", () => {
      const dir = path.join(os.tmpdir(), `session-config-${Date.now()}`);
      const { session } = makeSession({
        config: {
          ...makeConfig(dir),
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
              textVerbosity: "medium",
            },
            "codex-cli": {
              reasoningEffort: "none",
              textVerbosity: "low",
            },
            google: {
              nativeWebSearch: true,
              thinkingConfig: {
                includeThoughts: true,
                thinkingLevel: "high",
              },
            },
          },
        },
      });

      const evt = session.getSessionConfigEvent();
      expect(evt.config.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
        "codex-cli": {
          reasoningEffort: "none",
          textVerbosity: "low",
        },
        google: {
          nativeWebSearch: true,
          thinkingConfig: {
            thinkingLevel: "high",
          },
        },
      });
    });

    test("setConfig emits session_config and persists preferredChildModel/observability/backupsEnabled/toolOutputOverflowChars", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({ persistProjectConfigPatchImpl });

      await session.setConfig({
        preferredChildModel: "gemini-3.1-pro-preview",
        observabilityEnabled: true,
        backupsEnabled: true,
        toolOutputOverflowChars: null,
        maxSteps: 25,
      });

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeDefined();
      expect(cfgEvt.config.preferredChildModel).toBe("gemini-3.1-pro-preview");
      expect(cfgEvt.config.observabilityEnabled).toBe(true);
      expect(cfgEvt.config.backupsEnabled).toBe(true);
      expect(cfgEvt.config.defaultBackupsEnabled).toBe(true);
      expect(cfgEvt.config.toolOutputOverflowChars).toBeNull();
      expect(cfgEvt.config.defaultToolOutputOverflowChars).toBeNull();
      expect(cfgEvt.config.maxSteps).toBe(25);
      expect(cfgEvt.config.childModelRoutingMode).toBe("same-provider");
      expect(cfgEvt.config.preferredChildModelRef).toBe("google:gemini-3.1-pro-preview");
      expect(cfgEvt.config.allowedChildModelRefs).toEqual([]);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        preferredChildModel: "gemini-3.1-pro-preview",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "google:gemini-3.1-pro-preview",
        allowedChildModelRefs: [],
        observabilityEnabled: true,
        backupsEnabled: true,
        toolOutputOverflowChars: null,
      });
    });

    test("setConfig refreshes the cached system prompt when user profile fields change", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const loadSystemPromptWithSkillsImpl = mock(async (config: AgentConfig) => ({
        prompt: `prompt:${config.userName ?? ""}:${config.userProfile?.work ?? ""}`,
        discoveredSkills: [{ name: "refreshed-skill", description: "Refreshed skill" }],
      }));
      const { session } = makeSession({
        persistProjectConfigPatchImpl,
        loadSystemPromptWithSkillsImpl,
      });

      await session.setConfig({
        userName: "Casey",
        userProfile: { work: "Engineer" },
      });
      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        userName: "Casey",
        userProfile: { work: "Engineer" },
      });

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:Casey:Engineer");
      expect(runTurnArgs.discoveredSkills).toEqual([
        { name: "refreshed-skill", description: "Refreshed skill" },
      ]);

      const configEvent = session.getSessionConfigEvent();
      expect(configEvent.config.userName).toBe("Casey");
      expect(configEvent.config.userProfile.work).toBe("Engineer");
    });

    test("setConfig refreshes the cached system prompt when provider options change", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const loadSystemPromptWithSkillsImpl = mock(async (config: AgentConfig) => ({
        prompt: `prompt:${config.providerOptions?.google?.nativeWebSearch === true}`,
        discoveredSkills: [{ name: "native-web", description: "Native web" }],
      }));
      const { session } = makeSession({
        config: makeConfig("/tmp/test-session", {
          provider: "google",
          model: "gemini-3-flash-preview",
          preferredChildModel: "gemini-3-flash-preview",
        }),
        persistProjectConfigPatchImpl,
        loadSystemPromptWithSkillsImpl,
        system: "prompt:false",
      });

      await session.setConfig({
        providerOptions: {
          google: {
            nativeWebSearch: true,
          },
        },
      });
      await session.sendUserMessage("hello");

      expect(loadSystemPromptWithSkillsImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        providerOptions: {
          google: {
            nativeWebSearch: true,
          },
        },
      });

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:true");
      expect(runTurnArgs.discoveredSkills).toEqual([
        { name: "native-web", description: "Native web" },
      ]);
    });

    test("sendUserMessage waits for an in-flight setConfig prompt refresh", async () => {
      const refreshGate = Promise.withResolvers<void>();
      const loadSystemPromptWithSkillsImpl = mock(async (config: AgentConfig) => {
        await refreshGate.promise;
        return {
          prompt: `prompt:${config.userName ?? ""}:${config.userProfile?.work ?? ""}`,
          discoveredSkills: [{ name: "refreshed-skill", description: "Refreshed skill" }],
        };
      });
      const { session } = makeSession({
        loadSystemPromptWithSkillsImpl,
        system: "prompt:stale:",
      });

      const pendingConfig = session.setConfig({
        userName: "Casey",
        userProfile: { work: "Engineer" },
      });
      const pendingTurn = session.sendUserMessage("hello");

      await flushAsyncWork();
      expect(mockRunTurn).not.toHaveBeenCalled();

      refreshGate.resolve();
      await pendingConfig;
      await pendingTurn;

      const runTurnArgs = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(runTurnArgs.system).toBe("prompt:Casey:Engineer");
      expect(runTurnArgs.discoveredSkills).toEqual([
        { name: "refreshed-skill", description: "Refreshed skill" },
      ]);
    });

    test("setConfig normalizes cross-provider preferred child settings from the canonical ref", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
        persistProjectConfigPatchImpl,
      });

      await session.setConfig({
        childModelRoutingMode: "cross-provider-allowlist",
        preferredChildModel: "gemini-3.1-pro-preview",
        preferredChildModelRef: "google:gemini-3.1-pro-preview",
        allowedChildModelRefs: ["google:gemini-3.1-pro-preview"],
      });

      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        preferredChildModel: "gpt-5.2",
        childModelRoutingMode: "cross-provider-allowlist",
        preferredChildModelRef: "google:gemini-3.1-pro-preview",
        allowedChildModelRefs: ["google:gemini-3.1-pro-preview"],
      });
      expect(session.getSessionConfigEvent().config.preferredChildModel).toBe("gpt-5.2");
      expect(session.getSessionConfigEvent().config.childModelRoutingMode).toBe(
        "cross-provider-allowlist",
      );
      expect(session.getSessionConfigEvent().config.preferredChildModelRef).toBe(
        "google:gemini-3.1-pro-preview",
      );
      expect(session.getSessionConfigEvent().config.allowedChildModelRefs).toEqual([
        "google:gemini-3.1-pro-preview",
      ]);
      expect(events.some((evt) => evt.type === "error")).toBe(false);
    });

    test("setConfig can clear the persisted toolOutputOverflowChars override and restore inheritance", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({
        config: makeConfig("/tmp/test-session", {
          toolOutputOverflowChars: 12000,
          inheritedToolOutputOverflowChars: 25000,
          projectConfigOverrides: {
            toolOutputOverflowChars: 12000,
          },
        }),
        persistProjectConfigPatchImpl,
      });

      await session.setConfig({
        clearToolOutputOverflowChars: true,
      });

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeDefined();
      expect(cfgEvt.config.toolOutputOverflowChars).toBe(25000);
      expect("defaultToolOutputOverflowChars" in cfgEvt.config).toBe(false);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledTimes(1);
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        clearToolOutputOverflowChars: true,
      });
    });

    test("session_config keeps the persisted backup default separate from a live override", async () => {
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          backupsEnabled: true,
        },
      });

      await session.setBackupsEnabledOverride(false);

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeDefined();
      expect(cfgEvt.config.backupsEnabled).toBe(false);
      expect(cfgEvt.config.defaultBackupsEnabled).toBe(true);
    });

    test("setConfig persistence failures do not apply runtime config changes", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {
        throw new Error("persist failed");
      });
      const { session, events } = makeSession({ persistProjectConfigPatchImpl });

      await session.setConfig({
        preferredChildModel: "gemini-3.1-pro-preview",
        observabilityEnabled: true,
        maxSteps: 25,
      });

      const cfg = session.getSessionConfigEvent().config;
      expect(cfg.preferredChildModel).toBe("gemini-3-flash-preview");
      expect(cfg.observabilityEnabled).toBe(false);
      expect(cfg.maxSteps).toBe(100);

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeUndefined();

      const errEvt = events.find(
        (evt): evt is Extract<SessionEvent, { type: "error" }> => evt.type === "error",
      );
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("internal_error");
        expect(errEvt.message).toContain("Failed to persist config defaults");
      }
    });

    test("setConfig suppresses no-op writes when the effective config is unchanged", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({ persistProjectConfigPatchImpl });

      await session.setConfig({
        preferredChildModel: "gemini-3-flash-preview",
        childModelRoutingMode: "same-provider",
      });

      expect(persistProjectConfigPatchImpl).not.toHaveBeenCalled();
      expect(events.some((evt) => evt.type === "session_config")).toBe(false);
    });

    test("setConfig clears a live backup override even when the persisted default is unchanged", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          backupsEnabled: true,
        },
        persistProjectConfigPatchImpl,
      });

      await session.setBackupsEnabledOverride(false);
      events.length = 0;

      await session.setConfig({
        backupsEnabled: true,
      });

      expect(persistProjectConfigPatchImpl).not.toHaveBeenCalled();
      expect(session.getSessionConfigEvent().config.backupsEnabled).toBe(true);
      expect(session.getSessionConfigEvent().config.defaultBackupsEnabled).toBe(true);

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeDefined();
      expect(cfgEvt.config.backupsEnabled).toBe(true);
      expect(cfgEvt.config.defaultBackupsEnabled).toBe(true);
    });

    test("setConfig merges editable providerOptions and preserves unrelated keys", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {});
      const loadSystemPromptWithSkillsImpl = mock(async () => ({
        prompt: "prompt:provider-options",
        discoveredSkills: [],
      }));
      const dir = path.join(os.tmpdir(), `session-config-merge-${Date.now()}`);
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          providerOptions: {
            openai: {
              reasoningEffort: "high",
              reasoningSummary: "detailed",
              textVerbosity: "medium",
            },
          },
        },
        persistProjectConfigPatchImpl,
        loadSystemPromptWithSkillsImpl,
      });

      await session.setConfig({
        providerOptions: {
          openai: {
            textVerbosity: "low",
          },
          "codex-cli": {
            reasoningEffort: "xhigh",
          },
        },
      });

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt.config.providerOptions).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
          textVerbosity: "low",
        },
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      });
      expect(persistProjectConfigPatchImpl).toHaveBeenCalledWith({
        providerOptions: {
          openai: {
            textVerbosity: "low",
          },
          "codex-cli": {
            reasoningEffort: "xhigh",
          },
        },
      });
    });
  });
});
