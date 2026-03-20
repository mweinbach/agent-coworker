import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRuntime } from "../src/runtime";
import { SessionCostTracker } from "../src/session/costTracker";
import type { AgentConfig, TodoItem } from "../src/types";
import { ASK_SKIP_TOKEN, type ServerEvent } from "../src/server/protocol";
import { defaultSupportedModel } from "../src/models/registry";
import { __internal as observabilityRuntimeInternal } from "../src/observability/runtime";
import type {
  SessionBackupHandle,
  SessionBackupInitOptions,
  SessionBackupPublicCheckpoint,
  SessionBackupPublicState,
} from "../src/server/sessionBackup";
import type { SessionInfoState } from "../src/server/session/SessionContext";
import * as REAL_AGENT from "../src/agent";

// ---------------------------------------------------------------------------
// Mock runTurn before importing AgentSession (which imports ../agent)
// ---------------------------------------------------------------------------

const mockRunTurn = mock(async () => ({
  text: "",
  reasoningText: undefined as string | undefined,
  responseMessages: [] as any[],
}));

mock.module("../src/agent", () => ({
  runTurn: mockRunTurn,
}));

const mockConnectModelProvider = mock(async (_opts: any): Promise<any> => ({
  ok: true,
  provider: "openai",
  mode: "api_key",
  storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
  message: "Provider key saved.",
  maskedApiKey: "sk-t...est",
}));

const mockGetAiCoworkerPaths = mock((opts?: { homedir?: string }) => {
  const home = opts?.homedir ?? "/tmp/mock-home";
  const rootDir = path.join(home, ".cowork");
  const authDir = path.join(rootDir, "auth");
  return {
    rootDir,
    authDir,
    configDir: path.join(rootDir, "config"),
    sessionsDir: path.join(rootDir, "sessions"),
    logsDir: path.join(rootDir, "logs"),
    skillsDir: path.join(rootDir, "skills"),
    connectionsFile: path.join(authDir, "connections.json"),
  };
});

const mockGenerateSessionTitle = mock(async () => ({
  title: "Mock title",
  source: "heuristic" as const,
  model: null as string | null,
}));

const mockWritePersistedSessionSnapshot = mock(async () => "/tmp/mock-home/.cowork/sessions/mock.json");

// Import AgentSession AFTER the runTurn mock is registered so it picks up the mock.
const { AgentSession } = await import("../src/server/session/AgentSession");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(dir: string): AgentConfig {
  const userAgentDir = path.join(dir, ".agent-user");
  return {
    provider: "google",
    model: "gemini-3-flash-preview",
    preferredChildModel: "gemini-3-flash-preview",
    workingDirectory: dir,
    outputDirectory: path.join(dir, "output"),
    uploadsDirectory: path.join(dir, "uploads"),
    userName: "",
    knowledgeCutoff: "unknown",
    projectAgentDir: path.join(dir, ".agent"),
    userAgentDir,
    builtInDir: dir,
    builtInConfigDir: path.join(dir, "config"),
    skillsDirs: [path.join(path.dirname(userAgentDir), ".cowork", "skills")],
    memoryDirs: [],
    configDirs: [],
    enableMcp: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeEmit(): { emit: (evt: ServerEvent) => void; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const emit = (event: ServerEvent) => {
    events.push(event);
  };
  return { emit, events };
}

function makeSessionBackupFactory() {
  return mock(async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
    const createdAt = new Date().toISOString();
    const checkpoints: SessionBackupPublicCheckpoint[] = [
      {
        id: "cp-0001",
        index: 1,
        createdAt,
        trigger: "initial",
        changed: false,
        patchBytes: 0,
      },
    ];

    const getState = (): SessionBackupPublicState => ({
      status: "ready",
      sessionId: opts.sessionId,
      workingDirectory: opts.workingDirectory,
      backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
      createdAt,
      originalSnapshot: { kind: "directory" },
      checkpoints: [...checkpoints],
    });

    return {
      getPublicState: () => getState(),
      createCheckpoint: async (trigger) => {
        const checkpoint: SessionBackupPublicCheckpoint = {
          id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
          index: checkpoints.length + 1,
          createdAt: new Date().toISOString(),
          trigger,
          changed: true,
          patchBytes: 42,
        };
        checkpoints.push(checkpoint);
        return checkpoint;
      },
      restoreOriginal: async () => {},
      restoreCheckpoint: async (checkpointId) => {
        if (!checkpoints.some((cp) => cp.id === checkpointId)) {
          throw new Error(`Unknown checkpoint: ${checkpointId}`);
        }
      },
      deleteCheckpoint: async (checkpointId) => {
        const idx = checkpoints.findIndex((cp) => cp.id === checkpointId);
        if (idx < 0) return false;
        checkpoints.splice(idx, 1);
        return true;
      },
      reloadFromDisk: async () => getState(),
      close: async () => {},
    };
  });
}

function makeSession(
  overrides?: Partial<{
    config: AgentConfig;
    system: string;
    yolo: boolean;
    emit: (evt: ServerEvent) => void;
    connectProviderImpl: (opts: any) => Promise<any>;
    getAiCoworkerPathsImpl: (opts?: { homedir?: string }) => {
      rootDir: string;
      configDir: string;
      sessionsDir: string;
      logsDir: string;
      connectionsFile: string;
    };
    getProviderCatalogImpl: (opts: any) => Promise<any>;
    getProviderStatusesImpl: (opts: any) => Promise<any>;
    sessionBackupFactory: (opts: SessionBackupInitOptions) => Promise<SessionBackupHandle>;
    persistModelSelectionImpl: (selection: {
      provider: AgentConfig["provider"];
      model: string;
      preferredChildModel: string;
    }) => Promise<void> | void;
    persistProjectConfigPatchImpl: (
      patch: Partial<
        Pick<
          AgentConfig,
          "provider" | "model" | "preferredChildModel" | "enableMcp" | "enableMemory" | "memoryRequireApproval" | "observabilityEnabled" | "backupsEnabled" | "toolOutputOverflowChars" | "userName"
        >
      > & {
        userProfile?: Partial<NonNullable<AgentConfig["userProfile"]>>;
        clearToolOutputOverflowChars?: boolean;
      }
    ) => Promise<void> | void;
    loadSystemPromptWithSkillsImpl: (config: AgentConfig) => Promise<{
      prompt: string;
      discoveredSkills: Array<{ name: string; description: string }>;
    }>;
    generateSessionTitleImpl: (opts: { config: AgentConfig; query: string }) => Promise<{
      title: string;
      source: "default" | "model" | "heuristic";
      model: string | null;
    }>;
    writePersistedSessionSnapshotImpl: (opts: any) => Promise<string>;
    createAgentSessionImpl: (opts: any) => Promise<any>;
    listAgentSessionsImpl: (parentSessionId: string) => Promise<any[]>;
    sendAgentInputImpl: (opts: any) => Promise<void>;
    waitForAgentImpl: (opts: any) => Promise<any>;
    closeAgentImpl: (opts: any) => Promise<any>;
    cancelAgentSessionsImpl: (parentSessionId: string) => void;
    deleteSessionImpl: (opts: any) => Promise<void>;
    sessionInfoPatch: Partial<SessionInfoState>;
  }>
) {
  const dir = "/tmp/test-session";
  const { emit, events } = makeEmit();
  const sessionBackupFactory = overrides?.sessionBackupFactory ?? makeSessionBackupFactory();
  const getProviderStatusesImpl = overrides?.getProviderStatusesImpl ?? (async () => []);
  const session = new AgentSession({
    config: overrides?.config ?? makeConfig(dir),
    system: overrides?.system ?? "You are a test assistant.",
    yolo: overrides?.yolo,
    emit: overrides?.emit ?? emit,
    connectProviderImpl: overrides?.connectProviderImpl,
    getAiCoworkerPathsImpl: overrides?.getAiCoworkerPathsImpl,
    loadSystemPromptWithSkillsImpl: overrides?.loadSystemPromptWithSkillsImpl,
    getProviderCatalogImpl: overrides?.getProviderCatalogImpl as any,
    getProviderStatusesImpl,
    sessionBackupFactory,
    persistModelSelectionImpl: overrides?.persistModelSelectionImpl,
    persistProjectConfigPatchImpl: overrides?.persistProjectConfigPatchImpl,
    generateSessionTitleImpl: overrides?.generateSessionTitleImpl ?? mockGenerateSessionTitle,
    writePersistedSessionSnapshotImpl:
      overrides?.writePersistedSessionSnapshotImpl ?? mockWritePersistedSessionSnapshot,
    createAgentSessionImpl: overrides?.createAgentSessionImpl,
    listAgentSessionsImpl: overrides?.listAgentSessionsImpl,
    sendAgentInputImpl: overrides?.sendAgentInputImpl,
    waitForAgentImpl: overrides?.waitForAgentImpl,
    closeAgentImpl: overrides?.closeAgentImpl,
    cancelAgentSessionsImpl: overrides?.cancelAgentSessionsImpl,
    deleteSessionImpl: overrides?.deleteSessionImpl,
    sessionInfoPatch: overrides?.sessionInfoPatch,
  });
  return { session, emit, events, sessionBackupFactory };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentSession", () => {
  beforeEach(async () => {
    await observabilityRuntimeInternal.resetForTests();

    mockRunTurn.mockReset();
    mockRunTurn.mockImplementation(async () => ({
      text: "",
      reasoningText: undefined,
      responseMessages: [],
    }));

    mockConnectModelProvider.mockReset();
    mockConnectModelProvider.mockImplementation(async () => ({
      ok: true,
      provider: "openai",
      mode: "api_key",
      storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
      message: "Provider key saved.",
      maskedApiKey: "sk-t...est",
    }));

    mockGetAiCoworkerPaths.mockReset();
    mockGetAiCoworkerPaths.mockImplementation((opts?: { homedir?: string }) => {
      const home = opts?.homedir ?? "/tmp/mock-home";
      const rootDir = path.join(home, ".cowork");
      const authDir = path.join(rootDir, "auth");
      return {
        rootDir,
        authDir,
        configDir: path.join(rootDir, "config"),
        sessionsDir: path.join(rootDir, "sessions"),
        logsDir: path.join(rootDir, "logs"),
        skillsDir: path.join(rootDir, "skills"),
        connectionsFile: path.join(authDir, "connections.json"),
      };
    });

    mockGenerateSessionTitle.mockReset();
    mockGenerateSessionTitle.mockImplementation(async () => ({
      title: "Mock title",
      source: "heuristic",
      model: null,
    }));

    mockWritePersistedSessionSnapshot.mockReset();
    mockWritePersistedSessionSnapshot.mockImplementation(async () => "/tmp/mock-home/.cowork/sessions/mock.json");
  });

  afterAll(() => {
    mock.module("../src/agent", () => REAL_AGENT);
    mock.restore();
  });

  // =========================================================================
  // Constructor / Initialization
  // =========================================================================

  describe("Constructor / Initialization", () => {
    test("generates a unique session ID", () => {
      const { session } = makeSession();
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe("string");
      expect(session.id.length).toBeGreaterThan(0);
    });

    test("session ID looks like a UUID", () => {
      const { session } = makeSession();
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(session.id).toMatch(uuidPattern);
    });

    test("different instances have different IDs", () => {
      const { session: s1 } = makeSession();
      const { session: s2 } = makeSession();
      expect(s1.id).not.toBe(s2.id);
    });

    test("ten sessions all produce unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const { session } = makeSession();
        ids.add(session.id);
      }
      expect(ids.size).toBe(10);
    });

    test("exposes initial session_info payload", () => {
      const { session } = makeSession();
      const info = session.getSessionInfoEvent();
      expect(info.type).toBe("session_info");
      expect(info.title).toBe("New session");
      expect(info.titleSource).toBe("default");
      expect(info.titleModel).toBeNull();
      expect(info.provider).toBe("google");
      expect(info.model).toBe("gemini-3-flash-preview");
    });

    test("initializes with empty messages (sendUserMessage produces no history artifacts)", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("hello");
      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toHaveLength(1);
      expect(call.messages[0]).toEqual({ role: "user", content: "hello" });
    });

    test("initializes with empty todos (reset emits empty array)", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt).toBeDefined();
      expect(todosEvt.todos).toEqual([]);
    });

    test("writes an initial persisted session snapshot", async () => {
      makeSession();
      await flushAsyncWork();
      expect(mockWritePersistedSessionSnapshot).toHaveBeenCalledTimes(1);
      const first = mockWritePersistedSessionSnapshot.mock.calls[0]?.[0] as any;
      expect(first?.snapshot?.version).toBe(7);
      expect(first?.snapshot?.context?.providerState).toBeNull();
      expect(first?.snapshot?.context?.costTracker).toMatchObject({
        totalTurns: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        estimatedTotalCostUsd: null,
        costTrackingAvailable: false,
      });
      expect(first?.snapshot?.session?.title).toBe("New session");
    });
  });

  // =========================================================================
  // getPublicConfig
  // =========================================================================

  describe("getPublicConfig", () => {
    test("returns provider", () => {
      const { session } = makeSession();
      expect(session.getPublicConfig().provider).toBe("google");
    });

    test("returns model", () => {
      const { session } = makeSession();
      expect(session.getPublicConfig().model).toBe("gemini-3-flash-preview");
    });

    test("returns workingDirectory", () => {
      const dir = "/tmp/test-session";
      const { session } = makeSession({ config: makeConfig(dir) });
      expect(session.getPublicConfig().workingDirectory).toBe(dir);
    });

    test("returns outputDirectory", () => {
      const dir = "/tmp/test-session";
      const { session } = makeSession({ config: makeConfig(dir) });
      expect(session.getPublicConfig().outputDirectory).toBe(path.join(dir, "output"));
    });

    test("returns exactly four keys", () => {
      const { session } = makeSession();
      const keys = Object.keys(session.getPublicConfig());
      expect(keys).toEqual(["provider", "model", "workingDirectory", "outputDirectory"]);
    });

    test("does not include uploadsDirectory", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.uploadsDirectory).toBeUndefined();
    });

    test("does not include providerOptions", () => {
      const dir = "/tmp/test-session";
      const cfg = { ...makeConfig(dir), providerOptions: { google: { thinkingConfig: {} } } };
      const { session } = makeSession({ config: cfg });
      const pub = session.getPublicConfig() as any;
      expect(pub.providerOptions).toBeUndefined();
    });

    test("does not include preferredChildModel", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.preferredChildModel).toBeUndefined();
    });

    test("does not include userName", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.userName).toBeUndefined();
    });

    test("does not include skillsDirs", () => {
      const { session } = makeSession();
      const pub = session.getPublicConfig() as any;
      expect(pub.skillsDirs).toBeUndefined();
    });
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

    test("setEnableMcp persistence failures still apply runtime state and emit a non-fatal error", async () => {
      const persistProjectConfigPatchImpl = mock(async () => {
        throw new Error("write failed");
      });
      const { session, events } = makeSession({ persistProjectConfigPatchImpl });

      await session.setEnableMcp(false);

      expect(session.getEnableMcp()).toBe(false);
      expect(events.some((evt) => evt.type === "session_settings")).toBe(true);
      const errEvt = events.find((evt): evt is Extract<ServerEvent, { type: "error" }> => evt.type === "error");
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
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
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
      const errEvt = events.find((evt): evt is Extract<ServerEvent, { type: "error" }> => evt.type === "error");
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
      const errEvt = events.find((evt): evt is Extract<ServerEvent, { type: "error" }> => evt.type === "error");
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("internal_error");
        expect(errEvt.source).toBe("session");
        expect(errEvt.message).toContain("Failed to delete memory: Error: db delete failed");
      }
    });
  });

  describe("mcp management", () => {
    test("emitMcpServers emits layered snapshot event", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-emit-"));
      try {
        const config = makeConfig(tmpDir);
        await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          JSON.stringify(
            {
              servers: [{ name: "grep", transport: { type: "http", url: "https://mcp.grep.app" } }],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const { session, events } = makeSession({ config });
        await session.emitMcpServers();

        const evt = events.find((entry) => entry.type === "mcp_servers");
        expect(evt).toBeDefined();
        if (evt && evt.type === "mcp_servers") {
          expect(evt.servers.some((server) => server.name === "grep")).toBe(true);
          expect(evt.files.some((file) => file.source === "workspace")).toBe(true);
          expect(typeof evt.legacy.workspace.exists).toBe("boolean");
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("upsertMcpServer writes workspace .cowork mcp config", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-upsert-"));
      try {
        const config = makeConfig(tmpDir);
        const { session } = makeSession({ config });
        await session.upsertMcpServer({
          name: "local",
          transport: { type: "stdio", command: "echo", args: ["ok"] },
          auth: { type: "none" },
        });

        const persistedRaw = await fs.readFile(path.join(tmpDir, ".cowork", "mcp-servers.json"), "utf-8");
        expect(persistedRaw).toContain("\"name\": \"local\"");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("validateMcpServer blocks concurrent validation while connection flow is active", async () => {
      const { session, events } = makeSession();
      let releaseLookup: (() => void) | null = null;
      let lookupCalls = 0;
      const firstLookup = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });

      (session as any).getMcpServerByName = async () => {
        lookupCalls += 1;
        if (lookupCalls === 1) {
          await firstLookup;
        }
        return null;
      };

      const firstValidation = session.validateMcpServer("server-a");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await session.validateMcpServer("server-a");

      expect(lookupCalls).toBe(1);
      const busyErr = events.find(
        (entry) => entry.type === "error" && entry.message === "Connection flow already running",
      );
      expect(busyErr).toBeDefined();

      releaseLookup?.();
      await firstValidation;
    });

    test("setMcpServerApiKey emits auth result and writes auth file", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-api-key-"));
      try {
        const config = makeConfig(tmpDir);
        await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          JSON.stringify(
            {
              servers: [
                {
                  name: "protected",
                  transport: { type: "http", url: "https://mcp.example.com" },
                  auth: { type: "api_key", headerName: "Authorization", prefix: "Bearer" },
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const { session, events } = makeSession({ config });
        await session.setMcpServerApiKey("protected", "secret-token");

        const resultEvt = events.find((entry) => entry.type === "mcp_server_auth_result");
        expect(resultEvt).toBeDefined();
        if (resultEvt && resultEvt.type === "mcp_server_auth_result") {
          expect(resultEvt.ok).toBe(true);
          expect(resultEvt.mode).toBe("api_key");
        }

        const authRaw = await fs.readFile(path.join(tmpDir, ".cowork", "auth", "mcp-credentials.json"), "utf-8");
        expect(authRaw).toContain("secret-token");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("migrateLegacyMcpServers imports .agent fallback entries", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-mcp-migrate-"));
      try {
        const config = makeConfig(tmpDir);
        await fs.mkdir(path.join(tmpDir, ".agent"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".agent", "mcp-servers.json"),
          JSON.stringify(
            {
              servers: [
                { name: "legacy-one", transport: { type: "stdio", command: "echo", args: ["legacy"] } },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );
        await fs.mkdir(path.join(tmpDir, ".cowork"), { recursive: true });
        await fs.writeFile(
          path.join(tmpDir, ".cowork", "mcp-servers.json"),
          JSON.stringify({ servers: [{ name: "existing", transport: { type: "stdio", command: "echo" } }] }, null, 2),
          "utf-8",
        );

        const { session } = makeSession({ config });
        await session.migrateLegacyMcpServers("workspace");

        const migratedRaw = await fs.readFile(path.join(tmpDir, ".cowork", "mcp-servers.json"), "utf-8");
        expect(migratedRaw).toContain("\"name\": \"existing\"");
        expect(migratedRaw).toContain("\"name\": \"legacy-one\"");

        const archived = await fs.readFile(path.join(tmpDir, ".agent", "mcp-servers.legacy-migrated.json"), "utf-8");
        expect(archived).toContain("\"legacy-one\"");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
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
      expect(evt.config.backupsEnabled).toBe(true);
      expect(evt.config.defaultBackupsEnabled).toBe(true);
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
        backupsEnabled: false,
        toolOutputOverflowChars: null,
        maxSteps: 25,
      });

      const cfgEvt = events.filter((evt) => evt.type === "session_config").at(-1) as any;
      expect(cfgEvt).toBeDefined();
      expect(cfgEvt.config.preferredChildModel).toBe("gemini-3.1-pro-preview");
      expect(cfgEvt.config.observabilityEnabled).toBe(true);
      expect(cfgEvt.config.backupsEnabled).toBe(false);
      expect(cfgEvt.config.defaultBackupsEnabled).toBe(false);
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
        backupsEnabled: false,
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

    test("setConfig rejects unsupported preferredChildModel values before persistence", async () => {
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
        preferredChildModel: "gemini-3.1-pro-preview",
      });

      expect(persistProjectConfigPatchImpl).not.toHaveBeenCalled();
      expect(session.getSessionConfigEvent().config.preferredChildModel).toBe("gpt-5.2");
      expect(events.some((evt) => evt.type === "session_config")).toBe(false);

      const errEvt = events.find((evt): evt is Extract<ServerEvent, { type: "error" }> => evt.type === "error");
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("validation_failed");
        expect(errEvt.source).toBe("session");
        expect(errEvt.message).toContain('Unsupported session config preferred child target "gemini-3.1-pro-preview" for provider openai');
      }
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
      const { session, events } = makeSession();

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

      const errEvt = events.find((evt): evt is Extract<ServerEvent, { type: "error" }> => evt.type === "error");
      expect(errEvt).toBeDefined();
      if (errEvt) {
        expect(errEvt.code).toBe("internal_error");
        expect(errEvt.message).toContain("Failed to persist config defaults");
      }
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

  describe("skills", () => {
    async function makeTmpDir(prefix = "session-skills-test-"): Promise<string> {
      return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    }

    async function createSkill(parentDir: string, name: string, content: string): Promise<string> {
      const skillDir = path.join(parentDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      const normalizedContent =
        content.trimStart().startsWith("---")
          ? content
          : ["---", `name: \"${name}\"`, `description: \"${name} skill\"`, "---", "", content].join("\n");
      await fs.writeFile(path.join(skillDir, "SKILL.md"), normalizedContent, "utf-8");
      return skillDir;
    }

    test("listSkills emits skills_list with discovered entries", async () => {
      const tmp = await makeTmpDir();
      await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.listSkills();

      const evt = events.find((e) => e.type === "skills_list") as any;
      expect(evt).toBeDefined();
      expect(Array.isArray(evt.skills)).toBe(true);
      expect(evt.skills.some((s: any) => s.name === "alpha")).toBe(true);

      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha.source).toBe("project");
      expect(alpha.enabled).toBe(true);
      expect(String(alpha.path)).toContain(path.join("alpha", "SKILL.md"));
    });

    test("readSkill emits skill_content with content", async () => {
      const tmp = await makeTmpDir();
      await createSkill(tmp, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.readSkill("alpha");

      const evt = events.find((e) => e.type === "skill_content") as any;
      expect(evt).toBeDefined();
      expect(evt.skill.name).toBe("alpha");
      expect(evt.skill.enabled).toBe(true);
      expect(String(evt.content)).toContain("# Alpha Skill");
    });

    test("readSkill missing skill emits error", async () => {
      const tmp = await makeTmpDir();
      const cfg: AgentConfig = { ...makeConfig(tmp), skillsDirs: [tmp] };
      const { session, events } = makeSession({ config: cfg });

      await session.readSkill("missing");

      const evt = events.find((e) => e.type === "error") as any;
      expect(evt).toBeDefined();
      expect(evt.message).toContain('Skill "missing" not found.');
    });

    test("disableSkill moves global skill to disabled-skills and marks it disabled", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });

      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.disableSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha.source).toBe("global");
      expect(alpha.enabled).toBe(false);
      expect(String(alpha.path)).toContain(path.join("disabled-skills", "alpha", "SKILL.md"));
      await fs.access(path.join(root, "disabled-skills", "alpha", "SKILL.md"));
    });

    test("enableSkill moves global skill back to skills and marks it enabled", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      const disabled = path.join(root, "disabled-skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(disabled, { recursive: true });

      await createSkill(disabled, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.enableSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      const alpha = evt.skills.find((s: any) => s.name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha.source).toBe("global");
      expect(alpha.enabled).toBe(true);
      expect(String(alpha.path)).toContain(path.join("skills", "alpha", "SKILL.md"));
      await fs.access(path.join(root, "skills", "alpha", "SKILL.md"));
    });

    test("deleteSkill removes global skill directory", async () => {
      const root = await makeTmpDir();
      const project = path.join(root, "project-skills");
      const global = path.join(root, "skills");
      await fs.mkdir(project, { recursive: true });
      await fs.mkdir(global, { recursive: true });
      await createSkill(global, "alpha", "# Alpha Skill\nTRIGGERS: a\n");

      const cfg: AgentConfig = { ...makeConfig(root), skillsDirs: [project, global] };
      const { session, events } = makeSession({ config: cfg });

      await session.deleteSkill("alpha");

      const evt = events.filter((e) => e.type === "skills_list").at(-1) as any;
      expect(evt).toBeDefined();
      expect(evt.skills.some((s: any) => s.name === "alpha")).toBe(false);
      await expect(fs.access(path.join(root, "skills", "alpha"))).rejects.toBeDefined();
    });
  });

  describe("setModel", () => {
    test("updates model in-session and emits config_updated", async () => {
      const { session, events } = makeSession();
      await session.setModel("gemini-3-flash-preview");

      expect(session.getPublicConfig().provider).toBe("google");
      expect(session.getPublicConfig().model).toBe("gemini-3-flash-preview");
      const updated = events.find(
        (e): e is Extract<ServerEvent, { type: "config_updated" }> => e.type === "config_updated"
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
        (e): e is Extract<ServerEvent, { type: "config_updated" }> => e.type === "config_updated"
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
      const info = events.find((e): e is Extract<ServerEvent, { type: "session_info" }> => e.type === "session_info");
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

    test("persistence-hook failures keep model updates and emit a non-fatal error", async () => {
      const persistModelSelectionImpl = mock(async () => {
        throw new Error("disk write failed");
      });
      const { session, events } = makeSession({ persistModelSelectionImpl });

      await session.setModel("gemini-3-flash-preview");

      const updated = events.find((e): e is Extract<ServerEvent, { type: "config_updated" }> => e.type === "config_updated");
      expect(updated).toBeDefined();
      expect(session.getPublicConfig().model).toBe("gemini-3-flash-preview");
      const err = events.find(
        (e): e is Extract<ServerEvent, { type: "error" }> =>
          e.type === "error" && e.message.includes("Model updated for this session")
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
  });

  describe("provider catalog/auth methods", () => {
    test("emitProviderCatalog emits provider_catalog event", async () => {
      const catalog = {
        all: [
          { id: "openai", name: "OpenAI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" },
        ],
        default: { openai: "gpt-5.2" },
        connected: ["openai"],
      };
      const getProviderCatalogImpl = mock(async () => catalog);
      const { session, events } = makeSession({
        getProviderCatalogImpl: getProviderCatalogImpl as any,
      });

      await session.emitProviderCatalog();

      expect(getProviderCatalogImpl).toHaveBeenCalledTimes(1);
      const evt = events.find((e) => e.type === "provider_catalog");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_catalog") {
        expect(evt.all).toEqual(catalog.all);
        expect(evt.default).toEqual({
          ...catalog.default,
          google: "gemini-3-flash-preview",
        });
        expect(evt.connected).toEqual(catalog.connected);
      }
    });

    test("emitProviderAuthMethods emits provider_auth_methods event", () => {
      const { session, events } = makeSession();
      session.emitProviderAuthMethods();
      const evt = events.find((e) => e.type === "provider_auth_methods");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_auth_methods") {
        expect(evt.methods.openai?.some((m) => m.id === "api_key")).toBe(true);
        expect(evt.methods.google?.some((m) => m.id === "exa_api_key")).toBe(true);
      }
    });

    test("authorizeProviderAuth emits challenge for oauth method", async () => {
      const { session, events } = makeSession();
      await session.authorizeProviderAuth("codex-cli", "oauth_cli");
      const evt = events.find((e) => e.type === "provider_auth_challenge");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_auth_challenge") {
        expect(evt.provider).toBe("codex-cli");
        expect(evt.methodId).toBe("oauth_cli");
        expect(evt.challenge.method).toBe("auto");
        expect(evt.challenge.url).toBeUndefined();
      }
    });
  });

  describe("provider auth actions", () => {
    test("setProviderApiKey emits provider_auth_result and refreshes status/catalog", async () => {
      const statuses = [
        {
          provider: "openai",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-02-16T00:00:00.000Z",
        },
      ];
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "openai", name: "OpenAI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { openai: "gpt-5.2" },
        connected: ["openai"],
      }));
      const getProviderStatusesImpl = mock(async () => statuses);
      const { session, events } = makeSession({
        connectProviderImpl: mockConnectModelProvider,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_before_auth",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.setProviderApiKey("openai", "api_key", "sk-test");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("openai");
        expect(authEvt.methodId).toBe("api_key");
      }
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
      expect((session as any).state.providerState).toBeNull();
    });

    test("copyProviderApiKey emits provider_auth_result and refreshes status/catalog", async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "session-copy-provider-key-"));
      const connectionsFile = path.join(home, ".cowork", "auth", "connections.json");
      await fs.mkdir(path.dirname(connectionsFile), { recursive: true });
      await fs.writeFile(connectionsFile, JSON.stringify({
        version: 1,
        updatedAt: "2026-03-11T00:00:00.000Z",
        services: {
          "opencode-go": {
            service: "opencode-go",
            mode: "api_key",
            apiKey: "opencode-go-key-1234",
            updatedAt: "2026-03-11T00:00:00.000Z",
          },
        },
      }), "utf-8");

      const statuses = [
        {
          provider: "opencode-zen",
          authorized: true,
          verified: false,
          mode: "api_key",
          account: null,
          message: "API key saved.",
          checkedAt: "2026-03-11T00:00:00.000Z",
          savedApiKeyMasks: { api_key: "open...1234" },
        },
      ];
      const getProviderCatalogImpl = mock(async () => ({
        all: [
          { id: "opencode-go", name: "OpenCode Go", models: ["glm-5", "kimi-k2.5"], defaultModel: "glm-5" },
          {
            id: "opencode-zen",
            name: "OpenCode Zen",
            models: [
              "glm-5",
              "kimi-k2.5",
              "nemotron-3-super-free",
              "mimo-v2-flash-free",
              "big-pickle",
              "minimax-m2.5-free",
              "minimax-m2.5",
            ],
            defaultModel: "glm-5",
          },
        ],
        default: { "opencode-go": "glm-5", "opencode-zen": "glm-5" },
        connected: ["opencode-go", "opencode-zen"],
      }));
      const getProviderStatusesImpl = mock(async () => statuses);
      const connectProviderImpl = mock(async (opts: any) => ({
        ok: true,
        provider: opts.provider,
        mode: "api_key",
        storageFile: connectionsFile,
        message: "Provider key saved.",
        maskedApiKey: "open...1234",
      }));
      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session"),
          userAgentDir: path.join(home, ".agent"),
        },
        connectProviderImpl: connectProviderImpl as any,
        getAiCoworkerPathsImpl: mock(({ homedir }: { homedir?: string } = {}) => ({
          rootDir: path.join(homedir ?? home, ".cowork"),
          authDir: path.join(homedir ?? home, ".cowork", "auth"),
          configDir: path.join(homedir ?? home, ".cowork", "config"),
          sessionsDir: path.join(homedir ?? home, ".cowork", "sessions"),
          logsDir: path.join(homedir ?? home, ".cowork", "logs"),
          skillsDir: path.join(homedir ?? home, ".cowork", "skills"),
          connectionsFile,
        })),
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });

      await session.copyProviderApiKey("opencode-zen", "opencode-go");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("opencode-zen");
        expect(authEvt.methodId).toBe("api_key");
        expect(authEvt.message).toContain("Copied OpenCode Go API key");
      }
      expect(connectProviderImpl).toHaveBeenCalledTimes(1);
      expect(connectProviderImpl.mock.calls[0]?.[0]?.provider).toBe("opencode-zen");
      expect(connectProviderImpl.mock.calls[0]?.[0]?.apiKey).toBe("opencode-go-key-1234");
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
    });

    test("callbackProviderAuth emits provider_auth_result for oauth method", async () => {
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { "codex-cli": "gpt-5.2" },
        connected: ["codex-cli"],
      }));
      const getProviderStatusesImpl = mock(async () => []);
      mockConnectModelProvider.mockImplementationOnce(async () => ({
        ok: true,
        provider: "codex-cli",
        mode: "oauth",
        storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
        message: "OAuth sign-in completed.",
      }));
      const { session, events } = makeSession({
        connectProviderImpl: mockConnectModelProvider,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });
      (session as any).state.providerState = {
        provider: "codex-cli",
        model: "gpt-5.2",
        responseId: "resp_before_oauth",
        updatedAt: "2026-02-16T00:00:00.000Z",
        accountId: "acct_123",
      };

      await session.authorizeProviderAuth("codex-cli", "oauth_cli");
      await session.callbackProviderAuth("codex-cli", "oauth_cli");

      const authEvt = events.find((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("codex-cli");
      }
      expect((session as any).state.providerState).toBeNull();
    });

    test("callbackProviderAuth rejects pasted auth codes for auto Codex oauth", async () => {
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { "codex-cli": "gpt-5.2" },
        connected: ["codex-cli"],
      }));
      const getProviderStatusesImpl = mock(async () => []);
      const { session, events } = makeSession({
        connectProviderImpl: mockConnectModelProvider,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });
      (session as any).state.providerState = {
        provider: "codex-cli",
        model: "gpt-5.2",
        responseId: "resp_before_oauth",
        updatedAt: "2026-02-16T00:00:00.000Z",
        accountId: "acct_123",
      };

      await session.authorizeProviderAuth("codex-cli", "oauth_cli");
      await session.callbackProviderAuth("codex-cli", "oauth_cli", "manual-auth-code");

      const authEvt = events.findLast((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(false);
        expect(authEvt.provider).toBe("codex-cli");
        expect(authEvt.methodId).toBe("oauth_cli");
        expect(authEvt.message).toContain("does not accept a pasted authorization code");
      }
      expect(mockConnectModelProvider).not.toHaveBeenCalled();
    });

    test("logoutProviderAuth emits provider_auth_result and clears provider state", async () => {
      const getProviderCatalogImpl = mock(async () => ({
        all: [{ id: "codex-cli", name: "Codex CLI", models: ["gpt-5.2"], defaultModel: "gpt-5.2" }],
        default: { "codex-cli": "gpt-5.2" },
        connected: [],
      }));
      const getProviderStatusesImpl = mock(async () => []);
      const connectProviderImpl = mock(async (_opts: any) => ({
        ok: true,
        provider: "codex-cli",
        mode: "oauth",
        storageFile: "/tmp/mock-home/.cowork/auth/connections.json",
        message: "OAuth sign-in completed.",
      }));
      const { session, events } = makeSession({
        connectProviderImpl: connectProviderImpl as any,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderCatalogImpl: getProviderCatalogImpl as any,
        getProviderStatusesImpl: getProviderStatusesImpl as any,
      });
      (session as any).state.providerState = {
        provider: "codex-cli",
        model: "gpt-5.2",
        responseId: "resp_before_logout",
        updatedAt: "2026-02-16T00:00:00.000Z",
        accountId: "acct_123",
      };

      await session.logoutProviderAuth("codex-cli");

      const authEvt = events.findLast((e) => e.type === "provider_auth_result");
      expect(authEvt).toBeDefined();
      if (authEvt && authEvt.type === "provider_auth_result") {
        expect(authEvt.ok).toBe(true);
        expect(authEvt.provider).toBe("codex-cli");
        expect(authEvt.methodId).toBe("logout");
      }
      expect(events.some((e) => e.type === "provider_status")).toBe(true);
      expect(events.some((e) => e.type === "provider_catalog")).toBe(true);
      expect((session as any).state.providerState).toBeNull();
    });
  });

  describe("refreshProviderStatus", () => {
    test("emits provider_status with computed statuses", async () => {
      const dir = "/tmp/test-session-provider-status";
      const config = makeConfig(dir);
      const statuses = [
        {
          provider: "codex-cli",
          authorized: true,
          verified: true,
          mode: "oauth",
          account: { email: "user@example.com", name: "User" },
          message: "ok",
          checkedAt: "2026-02-09T00:00:00.000Z",
        },
      ];

      const mockGetProviderStatuses = mock(async () => statuses);
      const { session, events } = makeSession({
        config,
        getAiCoworkerPathsImpl: mockGetAiCoworkerPaths,
        getProviderStatusesImpl: mockGetProviderStatuses,
      });

      await session.refreshProviderStatus();

      expect(mockGetAiCoworkerPaths).toHaveBeenCalledWith({ homedir: os.homedir() });
      expect(mockGetProviderStatuses).toHaveBeenCalledTimes(1);

      const evt = events.find((e) => e.type === "provider_status");
      expect(evt).toBeDefined();
      if (evt && evt.type === "provider_status") {
        expect(evt.sessionId).toBe(session.id);
        expect(evt.providers).toEqual(statuses);
      }
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe("reset", () => {
    test("clears messages array (subsequent send starts fresh)", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("first");
      session.reset();
      await session.sendUserMessage("second");
      const lastCall = mockRunTurn.mock.calls[1][0] as any;
      expect(lastCall.messages).toHaveLength(1);
      expect(lastCall.messages[0].content).toBe("second");
    });

    test("clears persisted OpenAI continuation state", () => {
      const { session } = makeSession();
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_123",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      session.reset();

      expect((session as any).state.providerState).toBeNull();
    });

    test("emits reset_done when idle", () => {
      const { session, events } = makeSession();
      session.reset();
      const doneEvt = events.find((e) => e.type === "reset_done") as any;
      expect(doneEvt).toBeDefined();
      expect(doneEvt.sessionId).toBe(session.id);
    });

    test("reset while running emits error and does not clear messages", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () =>
              resolve({
                text: "",
                reasoningText: undefined,
                responseMessages: [{ role: "assistant", content: "ok" }],
              });
          })
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      session.reset();
      const errEvt = events.find((e) => e.type === "error") as any;
      expect(errEvt).toBeDefined();
      expect(errEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;

      mockRunTurn.mockImplementationOnce(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));
      await session.sendUserMessage("second");
      const secondCall = mockRunTurn.mock.calls[1][0] as any;
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0]).toEqual({ role: "user", content: "first" });
      expect(secondCall.messages[1]).toEqual({ role: "assistant", content: "ok" });
      expect(secondCall.messages[2]).toEqual({ role: "user", content: "second" });
    });

    test("clears todos array", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.todos).toEqual([]);
    });

    test("emits todos event with empty array", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvents = events.filter((e) => e.type === "todos");
      expect(todosEvents).toHaveLength(1);
      expect((todosEvents[0] as any).todos).toEqual([]);
    });

    test("emitted todos event contains the session id", () => {
      const { session, events } = makeSession();
      session.reset();
      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.sessionId).toBe(session.id);
    });

    test("can be called multiple times without error", () => {
      const { session } = makeSession();
      expect(() => {
        session.reset();
        session.reset();
        session.reset();
      }).not.toThrow();
    });
  });

  // =========================================================================
  // handleAskResponse
  // =========================================================================

  describe("handleAskResponse", () => {
    test("resolves pending deferred promise with the provided answer", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("What is your name?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      expect(askEvt).toBeDefined();
      expect(askEvt.question).toBe("What is your name?");

      session.handleAskResponse(askEvt.requestId, "Alice");
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Alice");
    });

    test("rejects blank ask answers, emits validation error, and replays same ask request", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("What should I do?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const firstAsk = events.find((e) => e.type === "ask") as any;
      expect(firstAsk).toBeDefined();

      let settled = false;
      void sendPromise.then(() => {
        settled = true;
      });

      session.handleAskResponse(firstAsk.requestId, "   ");
      await new Promise((r) => setTimeout(r, 10));

      expect(settled).toBe(false);

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.code).toBe("validation_failed");
      expect(errorEvt.source).toBe("session");
      expect(errorEvt.message).toContain("cannot be empty");

      const askEvents = events.filter((e) => e.type === "ask") as any[];
      expect(askEvents.length).toBeGreaterThanOrEqual(2);
      expect(askEvents[1]?.requestId).toBe(firstAsk.requestId);

      session.handleAskResponse(firstAsk.requestId, "Proceed");
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Proceed");
    });

    test("accepts explicit ask skip token", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("Continue?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      expect(askEvt).toBeDefined();

      session.handleAskResponse(askEvt.requestId, ASK_SKIP_TOKEN);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe(ASK_SKIP_TOKEN);

      const validationErrors = events.filter((e) => e.type === "error" && (e as any).code === "validation_failed");
      expect(validationErrors.length).toBe(0);
    });

    test("removes request from pending map after resolution", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("question?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      session.handleAskResponse(askEvt.requestId, "answer");

      session.handleAskResponse(askEvt.requestId, "other");
      const warnEvt = events.findLast((evt) => evt.type === "log");
      expect(warnEvt).toMatchObject({
        type: "log",
        line: `[warn] ask_response for unknown requestId: ${askEvt.requestId}`,
      });
      await sendPromise;
    });

    test("logs and ignores unknown requestId", () => {
      const { session, events } = makeSession();
      session.handleAskResponse("nonexistent-id", "test");
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] ask_response for unknown requestId: nonexistent-id",
      });
    });

    test("logs and ignores empty requestId", () => {
      const { session, events } = makeSession();
      session.handleAskResponse("", "test");
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] ask_response for unknown requestId: ",
      });
    });

    test("cleans pending ask replay cache when prompt wait rejects", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;
      sessionAny.waitForPromptResponse = mock(async () => {
        throw new Error("Ask prompt timed out waiting for user response.");
      });

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.askUser("question?").catch(() => {});
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");

      const askEvt = events.find((e) => e.type === "ask");
      expect(askEvt).toBeDefined();
      expect((sessionAny.pendingAskEvents as Map<string, unknown>).size).toBe(0);
    });

    test("keeps the projector pending ask flag in sync after resolution", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;

      mockRunTurn.mockImplementation(async (params: any) => {
        const answer = await params.askUser("question?");
        return { text: answer, reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const askEvt = events.find((e) => e.type === "ask") as any;
      expect(askEvt).toBeDefined();
      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingAsk).toBe(true);

      session.handleAskResponse(askEvt.requestId, "answer");
      await sendPromise;

      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingAsk).toBe(false);
    });
  });

  // =========================================================================
  // handleApprovalResponse
  // =========================================================================

  describe("handleApprovalResponse", () => {
    test("resolves pending deferred promise with approved=true", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("install deps");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.command).toBe("npm install");
      expect(approvalEvt.reasonCode).toBe("requires_manual_review");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("approved");
    });

    test("resolves pending deferred promise with approved=false", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("install deps");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      session.handleApprovalResponse(approvalEvt.requestId, false);
      await sendPromise;

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("denied");
    });

    test("removes request from pending map after resolution", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("npm install");
        return { text: "done", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      session.handleApprovalResponse(approvalEvt.requestId, true);

      session.handleApprovalResponse(approvalEvt.requestId, false);
      const warnEvt = events.findLast((evt) => evt.type === "log");
      expect(warnEvt).toMatchObject({
        type: "log",
        line: `[warn] approval_response for unknown requestId: ${approvalEvt.requestId}`,
      });
      await sendPromise;
    });

    test("logs and ignores unknown requestId", () => {
      const { session, events } = makeSession();
      session.handleApprovalResponse("nonexistent-id", true);
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] approval_response for unknown requestId: nonexistent-id",
      });
    });

    test("logs and ignores empty requestId", () => {
      const { session, events } = makeSession();
      session.handleApprovalResponse("", false);
      expect(events).toContainEqual({
        type: "log",
        sessionId: (session as any).id,
        line: "[warn] approval_response for unknown requestId: ",
      });
    });

    test("cleans pending approval replay cache when prompt wait rejects", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;
      sessionAny.waitForPromptResponse = mock(async () => {
        throw new Error("Command approval timed out waiting for user response.");
      });

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("npm install").catch(() => {});
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeDefined();
      expect((sessionAny.pendingApprovalEvents as Map<string, unknown>).size).toBe(0);
    });

    test("keeps the projector pending approval flag in sync after resolution", async () => {
      const { session, events } = makeSession();
      const sessionAny = session as any;

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("npm install");
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingApproval).toBe(true);

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;

      expect(sessionAny.sessionSnapshotProjector.getSnapshot().hasPendingApproval).toBe(false);
    });

    test("marks dangerous commands in the approval event", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("rm -rf /");
        return { text: "done", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.dangerous).toBe(true);
      expect(approvalEvt.reasonCode).toBe("matches_dangerous_pattern");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;
    });

    test("marks outside-scope absolute paths with outside_allowed_scope", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        await params.approveCommand("ls /etc");
        return { text: "done", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const approvalEvt = events.find((e) => e.type === "approval") as any;
      expect(approvalEvt).toBeDefined();
      expect(approvalEvt.dangerous).toBe(false);
      expect(approvalEvt.reasonCode).toBe("outside_allowed_scope");

      session.handleApprovalResponse(approvalEvt.requestId, true);
      await sendPromise;
    });

    test("auto-approved commands skip the approval flow entirely", async () => {
      const { session, events } = makeSession();

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("ls -la");
        return { text: approved ? "auto-approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("list files");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("auto-approved");
    });

    test("yolo mode skips approval flow even for dangerous commands", async () => {
      const { session, events } = makeSession({ yolo: true });

      mockRunTurn.mockImplementation(async (params: any) => {
        const approved = await params.approveCommand("rm -rf /tmp/whatever");
        return { text: approved ? "approved" : "denied", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");

      const approvalEvt = events.find((e) => e.type === "approval");
      expect(approvalEvt).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("approved");
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe("dispose", () => {
    test("rejects all pending ask requests", async () => {
      const { session } = makeSession();

      let askPromise!: Promise<string>;
      mockRunTurn.mockImplementation(async (params: any) => {
        askPromise = params.askUser("question?");
        try {
          await askPromise;
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("shutting down");

      await expect(askPromise).rejects.toThrow("Session disposed (shutting down)");
      await sendPromise;
    });

    test("rejects all pending approval requests", async () => {
      const { session } = makeSession();

      let approvalPromise!: Promise<boolean>;
      mockRunTurn.mockImplementation(async (params: any) => {
        approvalPromise = params.approveCommand("npm install");
        try {
          await approvalPromise;
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("cleanup");

      await expect(approvalPromise).rejects.toThrow("Session disposed (cleanup)");
      await sendPromise;
    });

    test("includes reason in error message", async () => {
      const { session } = makeSession();

      let askPromise!: Promise<string>;
      mockRunTurn.mockImplementation(async (params: any) => {
        askPromise = params.askUser("q?");
        try {
          await askPromise;
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("user disconnected");
      await expect(askPromise).rejects.toThrow("user disconnected");
      await sendPromise;
    });

    test("handles being called multiple times without error", () => {
      const { session } = makeSession();
      expect(() => {
        session.dispose("first");
        session.dispose("second");
        session.dispose("third");
      }).not.toThrow();
    });

    test("handles dispose when no pending requests exist", () => {
      const { session } = makeSession();
      expect(() => session.dispose("no-op")).not.toThrow();
    });

    test("rejects both ask and approval requests simultaneously", async () => {
      const { session } = makeSession();

      let askPromise!: Promise<string>;
      let approvalPromise!: Promise<boolean>;

      mockRunTurn.mockImplementation(async (params: any) => {
        askPromise = params.askUser("ask?");
        approvalPromise = params.approveCommand("npm install");
        try {
          await Promise.all([askPromise, approvalPromise]);
        } catch {
          // expected
        }
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      session.dispose("both");

      await expect(askPromise).rejects.toThrow("Session disposed");
      await expect(approvalPromise).rejects.toThrow("Session disposed");
      await sendPromise;
    });
  });

  // =========================================================================
  // sendUserMessage
  // =========================================================================

  describe("sendUserMessage", () => {
    test("rejects if already running (emits error)", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
      );

      const first = session.sendUserMessage("first");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendUserMessage("second");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toBe("Agent is busy");

      resolveRunTurn();
      await first;
    });

    test("sets running=true then false after completion", async () => {
      const { session, events } = makeSession();

      let wasRunningDuringExecution = false;

      mockRunTurn.mockImplementation(async () => {
        await session.sendUserMessage("concurrent");
        const busyError = events.find((e) => e.type === "error" && (e as any).message === "Agent is busy");
        wasRunningDuringExecution = busyError !== undefined;
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      await session.sendUserMessage("go");
      expect(wasRunningDuringExecution).toBe(true);

      events.length = 0;
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));
      await session.sendUserMessage("after");
      const errorEvt = events.find((e) => e.type === "error");
      expect(errorEvt).toBeUndefined();
    });

    test("emits session_busy true then false", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
      );

      const p = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const busyTrueIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === true);
      const busyFalseIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === false);
      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBe(-1);

      resolveRunTurn();
      await p;

      const busyFalseIdxAfter = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === false);
      expect(busyFalseIdxAfter).toBeGreaterThan(busyTrueIdx);
    });

    test("accepts steer_message for the active turn without emitting another busy=true", async () => {
      const { session, events } = makeSession();

      let capturedPrepareStep: ((step: { stepNumber: number; messages: any[] }) => Promise<any>) | undefined;
      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        (params: any) =>
          new Promise((resolve) => {
            capturedPrepareStep = params.prepareStep;
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const busyTrue = events.find((e) => e.type === "session_busy" && (e as any).busy === true) as any;
      expect(busyTrue?.turnId).toBeTruthy();

      await session.sendSteerMessage("narrow the scope", busyTrue.turnId, "steer-1");

      const steerAccepted = events.find((e) => e.type === "steer_accepted") as Extract<ServerEvent, { type: "steer_accepted" }> | undefined;
      expect(steerAccepted).toBeDefined();
      expect(steerAccepted?.turnId).toBe(busyTrue.turnId);
      expect(events.filter((e) => e.type === "session_busy" && (e as any).busy === true)).toHaveLength(1);
      expect(
        events.some((e) => e.type === "user_message" && (e as any).text === "narrow the scope"),
      ).toBe(false);

      await capturedPrepareStep?.({
        stepNumber: 1,
        messages: [{ role: "user", content: "go" }],
      });

      resolveRunTurn();
      await turnPromise;
    });

    test("rejects steer_message for the wrong active turn id", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendSteerMessage("continue", "wrong-turn", "steer-wrong");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt?.message).toBe("Active turn mismatch.");
      expect(events.some((e) => e.type === "steer_accepted")).toBe(false);

      resolveRunTurn();
      await turnPromise;
    });

    test("commits an accepted steer only when prepareStep drains it", async () => {
      const { session, events } = makeSession();
      let capturedPrepareStep: ((step: { stepNumber: number; messages: any[] }) => Promise<any>) | undefined;
      let resolveRunTurn!: () => void;

      mockRunTurn.mockImplementation(async (params: any) => {
        capturedPrepareStep = params.prepareStep;
        await new Promise<void>((resolve) => {
          resolveRunTurn = resolve;
        });
        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "done" }],
        };
      });

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const activeTurnId = session.activeTurnId;
      expect(activeTurnId).toBeTruthy();
      await session.sendSteerMessage("mention the queue behavior", activeTurnId!, "steer-commit");

      expect((session as any).state.allMessages.some((message: any) => message.content === "mention the queue behavior")).toBe(false);
      expect(
        events.some((e) => e.type === "user_message" && (e as any).clientMessageId === "steer-commit"),
      ).toBe(false);

      const baseMessages = [{ role: "user", content: "go" }];
      const prepareResult = await capturedPrepareStep?.({ stepNumber: 2, messages: baseMessages });
      expect(prepareResult?.messages).toEqual([
        ...baseMessages,
        { role: "user", content: "mention the queue behavior" },
      ]);
      expect((session as any).state.allMessages.some((message: any) => message.content === "mention the queue behavior")).toBe(true);
      expect(
        events.some((e) =>
          e.type === "user_message"
          && (e as any).text === "mention the queue behavior"
          && (e as any).clientMessageId === "steer-commit"),
      ).toBe(true);

      resolveRunTurn();
      await turnPromise;
    });

    test("injects a steer before the next model step in the same pass", async () => {
      const { session } = makeSession();
      const stepMessages: any[][] = [];
      let allowSecondStep!: () => void;

      mockRunTurn.mockImplementation(async (params: any) => {
        const initialMessages = [{ role: "user", content: "go" }];
        const stepOne = await params.prepareStep?.({ stepNumber: 1, messages: initialMessages });
        stepMessages.push(stepOne?.messages ?? initialMessages);

        await new Promise<void>((resolve) => {
          allowSecondStep = resolve;
        });

        const stepTwo = await params.prepareStep?.({
          stepNumber: 2,
          messages: stepMessages[0]!,
        });
        stepMessages.push(stepTwo?.messages ?? stepMessages[0]!);

        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "done" }],
        };
      });

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      await session.sendSteerMessage("mention tests", session.activeTurnId!, "steer-step");
      allowSecondStep();
      await turnPromise;

      expect(stepMessages).toHaveLength(2);
      expect(stepMessages[1]?.at(-1)).toEqual({ role: "user", content: "mention tests" });
    });

    test("late steer continuations only receive the remaining maxSteps budget", async () => {
      const { session } = makeSession();
      (session as any).state.maxSteps = 2;
      const seenMaxSteps: number[] = [];
      let runCount = 0;

      mockRunTurn.mockImplementation(async (params: any) => {
        runCount += 1;
        seenMaxSteps.push(params.maxSteps);
        await params.onModelStreamPart?.({ type: "start-step", stepNumber: 1 });

        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage("follow up once", session.activeTurnId!, "steer-remaining-steps");
          });
        }

        return {
          text: runCount === 1 ? "first pass" : "second pass",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: runCount === 1 ? "first pass" : "second pass" }],
        };
      });

      await session.sendUserMessage("go");

      expect(seenMaxSteps).toEqual([2, 1]);
    });

    test("continues the same outer turn for a late steer and emits one aggregated turn_usage", async () => {
      const { session, events } = makeSession();
      const seenTurnIds: string[] = [];
      const secondPassMessages: any[][] = [];
      let runCount = 0;

      mockRunTurn.mockImplementation(async (params: any) => {
        runCount += 1;
        seenTurnIds.push(String(params.telemetryContext?.metadata?.turnId ?? ""));

        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage("follow up in the same turn", session.activeTurnId!, "steer-late");
          });
          return {
            text: "first pass",
            reasoningText: undefined,
            responseMessages: [{ role: "assistant", content: "first pass" }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            providerState: {
              provider: "openai",
              model: "gpt-5.2",
              responseId: "resp_1",
              updatedAt: new Date().toISOString(),
            },
          };
        }

        secondPassMessages.push([...params.messages]);
        const prepareResult = await params.prepareStep?.({
          stepNumber: 1,
          messages: params.messages,
        });
        expect(prepareResult).toBeUndefined();

        return {
          text: "second pass",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "second pass" }],
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        };
      });

      await session.sendUserMessage("go");

      expect(runCount).toBe(2);
      expect(new Set(seenTurnIds).size).toBe(1);
      expect(secondPassMessages).toHaveLength(1);
      expect(secondPassMessages[0]?.at(-1)).toEqual({
        role: "user",
        content: "follow up in the same turn",
      });
      expect(events.filter((e) => e.type === "session_busy" && (e as any).busy === true)).toHaveLength(1);

      const usageEvents = events.filter((e) => e.type === "turn_usage") as Array<Extract<ServerEvent, { type: "turn_usage" }>>;
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.turnId).toBe(seenTurnIds[0]);
      expect(usageEvents[0]?.usage).toMatchObject({
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
      });

      const tracker = (session as any).state.costTracker as SessionCostTracker;
      const compact = tracker.getCompactSnapshot();
      expect(compact.totalTurns).toBe(1);
      expect(compact.turns).toHaveLength(1);
      expect(compact.turns[0]?.turnId).toBe(seenTurnIds[0]);
    });

    test("does not commit a late steer after the turn is cancelled", async () => {
      const { session, events } = makeSession();
      let runCount = 0;

      mockRunTurn.mockImplementation(async () => {
        runCount += 1;
        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage("follow up in the same turn", session.activeTurnId!, "steer-cancelled");
            queueMicrotask(() => {
              session.cancel();
            });
          });
          return {
            text: "first pass",
            reasoningText: undefined,
            responseMessages: [{ role: "assistant", content: "first pass" }],
          };
        }

        throw new Error("late steer continuation should not run after cancellation");
      });

      await session.sendUserMessage("go");

      expect(runCount).toBe(1);
      expect(
        (session as any).state.allMessages.some((message: any) => message.content === "follow up in the same turn"),
      ).toBe(false);
      expect(
        events.some((e) =>
          e.type === "user_message"
          && (e as any).clientMessageId === "steer-cancelled"),
      ).toBe(false);
    });

    test("does not cancel child agents unless explicitly requested", async () => {
      const cancelAgentSessionsImpl = mock(() => {});
      const { session } = makeSession({ cancelAgentSessionsImpl });

      mockRunTurn.mockImplementationOnce(async (params: any) => {
        await new Promise((_, reject) => {
          params.abortSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
            { once: true },
          );
        });

        throw new Error("unreachable");
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((resolve) => setTimeout(resolve, 0));

      session.cancel();
      await sendPromise;

      expect(cancelAgentSessionsImpl).not.toHaveBeenCalled();
    });

    test("can cancel child agents when a root turn is cancelled explicitly", async () => {
      const cancelAgentSessionsImpl = mock(() => {});
      const { session } = makeSession({ cancelAgentSessionsImpl });

      mockRunTurn.mockImplementationOnce(async (params: any) => {
        await new Promise((_, reject) => {
          params.abortSignal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" })),
            { once: true },
          );
        });

        throw new Error("unreachable");
      });

      const sendPromise = session.sendUserMessage("go");
      await new Promise((resolve) => setTimeout(resolve, 0));

      session.cancel({ includeSubagents: true });
      await sendPromise;

      expect(cancelAgentSessionsImpl).toHaveBeenCalledTimes(1);
      expect(cancelAgentSessionsImpl).toHaveBeenCalledWith(session.id);
    });

    test("can cancel child agents explicitly even when the root session is idle", () => {
      const cancelAgentSessionsImpl = mock(() => {});
      const { session } = makeSession({ cancelAgentSessionsImpl });

      session.cancel({ includeSubagents: true });

      expect(cancelAgentSessionsImpl).toHaveBeenCalledTimes(1);
      expect(cancelAgentSessionsImpl).toHaveBeenCalledWith(session.id);
    });

    test("persists aggregated usage when a late steer continuation errors after an earlier pass consumed tokens", async () => {
      const { session, events } = makeSession();
      let runCount = 0;

      mockRunTurn.mockImplementation(async () => {
        runCount += 1;

        if (runCount === 1) {
          queueMicrotask(() => {
            void session.sendSteerMessage("follow up and fail", session.activeTurnId!, "steer-error");
          });
          return {
            text: "first pass",
            reasoningText: undefined,
            responseMessages: [{ role: "assistant", content: "first pass" }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          };
        }

        throw new Error("follow-up provider failed");
      });

      await session.sendUserMessage("go");

      expect(runCount).toBe(2);

      const busyTrue = events.find(
        (e) => e.type === "session_busy" && (e as any).busy === true
      ) as Extract<ServerEvent, { type: "session_busy" }> | undefined;
      expect(busyTrue?.turnId).toBeTruthy();

      const usageEvents = events.filter((e) => e.type === "turn_usage") as Array<Extract<ServerEvent, { type: "turn_usage" }>>;
      expect(usageEvents).toHaveLength(1);
      expect(usageEvents[0]?.turnId).toBe(busyTrue?.turnId);
      expect(usageEvents[0]?.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      const tracker = (session as any).state.costTracker as SessionCostTracker;
      const compact = tracker.getCompactSnapshot();
      expect(compact.totalTurns).toBe(1);
      expect(compact.turns).toHaveLength(1);
      expect(compact.turns[0]?.turnId).toBe(busyTrue?.turnId);
      expect(compact.turns[0]?.usage).toMatchObject({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });

      const sessionUsageEvents = events.filter((e) => e.type === "session_usage") as Array<Extract<ServerEvent, { type: "session_usage" }>>;
      expect(sessionUsageEvents).toHaveLength(1);
      expect(sessionUsageEvents[0]?.usage?.totalTurns).toBe(1);
      expect(sessionUsageEvents[0]?.usage?.turns[0]?.turnId).toBe(busyTrue?.turnId);

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt?.message).toContain("follow-up provider failed");

      const busyFalse = events.find(
        (e) => e.type === "session_busy" && !(e as any).busy
      ) as Extract<ServerEvent, { type: "session_busy" }> | undefined;
      expect(busyFalse?.outcome).toBe("error");
    });

    test("rejects steer_message once the active turn stops accepting steering", async () => {
      const { session, events } = makeSession();

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          }),
      );

      const turnPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      const activeTurnId = session.activeTurnId;
      expect(activeTurnId).toBeTruthy();
      (session as any).state.acceptingSteers = false;

      await session.sendSteerMessage("too late", activeTurnId!, "steer-closed");

      const errorEvt = events.findLast((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt?.message).toBe("Active turn no longer accepts steering.");
      expect(events.some((e) => e.type === "steer_accepted" && (e as any).clientMessageId === "steer-closed")).toBe(false);

      resolveRunTurn();
      await turnPromise;
    });

    test("updates child session_info executionState across a successful turn", async () => {
      const { session, events } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      let resolveRunTurn!: () => void;
      mockRunTurn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRunTurn = () => resolve({ text: "", reasoningText: undefined, responseMessages: [] });
          })
      );

      const sendPromise = session.sendUserMessage("go");
      await new Promise((r) => setTimeout(r, 10));

      expect(
        events.some(
          (event) => event.type === "session_info" && event.sessionId === session.id && event.executionState === "running"
        )
      ).toBe(true);

      resolveRunTurn();
      await sendPromise;

      expect(session.getSessionInfoEvent().executionState).toBe("completed");
      expect(
        events.some(
          (event) => event.type === "session_info" && event.sessionId === session.id && event.executionState === "completed"
        )
      ).toBe(true);
    });

    test("updates child session_info executionState to errored when a turn fails", async () => {
      const { session, events } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      mockRunTurn.mockImplementation(async () => {
        throw new Error("delegate failed");
      });

      await session.sendUserMessage("go");

      expect(session.getSessionInfoEvent().executionState).toBe("errored");
      expect(
        events.some(
          (event) => event.type === "session_info" && event.sessionId === session.id && event.executionState === "running"
        )
      ).toBe(true);
      expect(
        events.some(
          (event) => event.type === "session_info" && event.sessionId === session.id && event.executionState === "errored"
        )
      ).toBe(true);
    });

    test("replaces a stale child preview with the latest error text on a failed rerun", async () => {
      const { session } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      mockRunTurn
        .mockImplementationOnce(async () => ({
          text: "First child result",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: [{ type: "text", text: "First child result" }] }],
        }))
        .mockImplementationOnce(async () => {
          throw new Error("delegate failed");
        });

      await session.sendUserMessage("first");
      expect(session.getSessionInfoEvent().lastMessagePreview).toBe("First child result");

      await session.sendUserMessage("second");
      expect(session.getSessionInfoEvent().executionState).toBe("errored");
      expect(session.getSessionInfoEvent().lastMessagePreview).toBe("delegate failed");
    });

    test("marks malformed repeated tool-call churn as a provider error", async () => {
      const { session, events } = makeSession({
        sessionInfoPatch: {
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "delegate",
          depth: 1,
          executionState: "pending_init",
        },
      });

      mockRunTurn.mockImplementationOnce(async () => ({
        text: "I'm having trouble with the function call format. Let me try again.",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "I'm having trouble with the function call format. Let me try again." }],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolName: "tool", output: { value: "Tool tool not found" }, isError: true }],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolName: "tool", output: { value: "Tool tool not found" }, isError: true }],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolName: "read", output: { value: "Invalid input: expected string, received undefined" }, isError: true }],
          },
        ],
      }));

      await session.sendUserMessage("go");

      expect(session.getSessionInfoEvent().executionState).toBe("errored");
      expect(session.getSessionInfoEvent().lastMessagePreview).toContain("Model failed to produce valid tool calls");
      expect(
        events.some(
          (event) => event.type === "error"
            && event.sessionId === session.id
            && event.code === "provider_error"
            && event.message.includes("Model failed to produce valid tool calls")
        )
      ).toBe(true);
      expect(events.some((event) => event.type === "assistant_message")).toBe(false);
    });

    test("clears busy and allows follow-up even when auto-checkpoint never resolves", async () => {
      const sessionBackupFactory = mock(async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
        const createdAt = new Date().toISOString();
        const checkpoints: SessionBackupPublicCheckpoint[] = [
          {
            id: "cp-0001",
            index: 1,
            createdAt,
            trigger: "initial",
            changed: false,
            patchBytes: 0,
          },
        ];
        const state = (): SessionBackupPublicState => ({
          status: "ready",
          sessionId: opts.sessionId,
          workingDirectory: opts.workingDirectory,
          backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
          createdAt,
          originalSnapshot: { kind: "directory" },
          checkpoints: [...checkpoints],
        });

        return {
          getPublicState: () => state(),
          createCheckpoint: async (trigger) => {
            if (trigger === "auto") {
              await new Promise<never>(() => {});
            }
            const checkpoint: SessionBackupPublicCheckpoint = {
              id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
              index: checkpoints.length + 1,
              createdAt: new Date().toISOString(),
              trigger,
              changed: true,
              patchBytes: 42,
            };
            checkpoints.push(checkpoint);
            return checkpoint;
          },
          restoreOriginal: async () => {},
          restoreCheckpoint: async (_checkpointId: string) => {},
          deleteCheckpoint: async (_checkpointId: string) => false,
          reloadFromDisk: async () => state(),
          close: async () => {},
        };
      });

      const { session, events } = makeSession({ sessionBackupFactory });

      const firstTurnResult = await Promise.race([
        session.sendUserMessage("first").then(() => "resolved" as const),
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), 50);
        }),
      ]);
      expect(firstTurnResult).toBe("resolved");

      const busyTrueIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === true);
      const busyFalseIdx = events.findIndex((e) => e.type === "session_busy" && (e as any).busy === false);
      expect(busyTrueIdx).toBeGreaterThanOrEqual(0);
      expect(busyFalseIdx).toBeGreaterThan(busyTrueIdx);

      events.length = 0;
      await session.sendUserMessage("follow-up");
      const busyError = events.find((e) => e.type === "error" && (e as any).message === "Agent is busy");
      expect(busyError).toBeUndefined();
    });

    test("emits user_message event", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello world");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt).toBeDefined();
      expect(userEvt.text).toBe("hello world");
      expect(userEvt.sessionId).toBe(session.id);
    });

    test("emits user_message event with clientMessageId when provided", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello", "msg-123");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.clientMessageId).toBe("msg-123");
    });

    test("emits user_message event without clientMessageId when not provided", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("hello");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.clientMessageId).toBeUndefined();
    });

    test("generates title once from the first accepted user prompt", async () => {
      mockGenerateSessionTitle.mockResolvedValueOnce({
        title: "First prompt title",
        source: "model",
        model: "gpt-5-mini",
      });
      const { session, events } = makeSession();

      await session.sendUserMessage("first question");
      await session.sendUserMessage("second question");
      await flushAsyncWork();

      expect(mockGenerateSessionTitle).toHaveBeenCalledTimes(1);
      expect(mockGenerateSessionTitle.mock.calls[0]?.[0]).toMatchObject({
        query: "first question",
      });
      const infoEvents = events.filter((evt): evt is Extract<ServerEvent, { type: "session_info" }> => evt.type === "session_info");
      expect(infoEvents.some((evt) => evt.title === "First prompt title")).toBe(true);
    });

    test("manual titles are not overwritten by in-flight auto title generation", async () => {
      let resolveTitle!: (value: { title: string; source: "heuristic"; model: null }) => void;
      mockGenerateSessionTitle.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveTitle = resolve;
          })
      );

      const { session } = makeSession();

      await session.sendUserMessage("first question");
      session.setSessionTitle("My Manual Title");

      resolveTitle({ title: "Generated Title", source: "heuristic", model: null });
      await flushAsyncWork();

      const info = session.getSessionInfoEvent();
      expect(info.title).toBe("My Manual Title");
      expect(info.titleSource).toBe("manual");
      expect(info.titleModel).toBeNull();
    });

    test("adds user message to messages array", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("test message");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toContainEqual({ role: "user", content: "test message" });
    });

    test("calls runTurn with config, system, messages", async () => {
      const dir = "/tmp/test-session";
      const config = makeConfig(dir);
      const { session } = makeSession({ config, system: "Be helpful." });
      await session.sendUserMessage("question");

      expect(mockRunTurn).toHaveBeenCalledTimes(1);
      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.config).toEqual(config);
      expect(call.system).toBe("Be helpful.");
      expect(call.messages).toEqual([{ role: "user", content: "question" }]);
    });

    test("passes allMessages and providerState to runTurn", async () => {
      const { session } = makeSession();
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_prev",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.sendUserMessage("question");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.messages).toEqual([{ role: "user", content: "question" }]);
      expect(call.allMessages).toEqual([{ role: "user", content: "question" }]);
      expect(call.providerState).toEqual({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_prev",
        updatedAt: "2026-02-16T00:00:00.000Z",
      });
    });

    test("passes maxSteps=100 to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.maxSteps).toBe(100);
    });

    test("passes enableMcp from config to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.enableMcp).toBe(true);
    });

    test("passes includeRawChunks and onModelStreamPart to runTurn", async () => {
      const { session } = makeSession();
      await session.sendUserMessage("go");

      const call = mockRunTurn.mock.calls[0][0] as any;
      expect(call.includeRawChunks).toBe(true);
      expect(typeof call.onModelStreamPart).toBe("function");
    });

    test("adds response messages to history", async () => {
      const responseMsg = { role: "assistant" as const, content: "I helped!" };
      let callNum = 0;
      mockRunTurn.mockImplementation(async () => {
        callNum++;
        return {
          text: callNum === 1 ? "I helped!" : "",
          reasoningText: undefined,
          // Only return responseMessages on first call to avoid reference mutation
          responseMessages: callNum === 1 ? [responseMsg] : [],
        };
      });

      const { session } = makeSession();
      await session.sendUserMessage("first");
      await session.sendUserMessage("second");

      // After first call completes, responseMsg was pushed to messages.
      // Second call should see [user:first, responseMsg, user:second]
      const secondCall = mockRunTurn.mock.calls[1][0] as any;
      expect(secondCall.messages).toHaveLength(3);
      expect(secondCall.messages[0]).toEqual({ role: "user", content: "first" });
      expect(secondCall.messages[1]).toEqual(responseMsg);
      expect(secondCall.messages[2]).toEqual({ role: "user", content: "second" });
    });

    test("retries once when the stored OpenAI continuation handle is rejected", async () => {
      mockRunTurn
        .mockImplementationOnce(async () => {
          throw new Error("Invalid previous_response_id: response not found");
        })
        .mockImplementationOnce(async () => ({
          text: "ok",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "ok" }],
          providerState: {
            provider: "openai",
            model: "gpt-5.2",
            responseId: "resp_fresh",
            updatedAt: "2026-02-16T00:00:02.000Z",
          },
        }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const, model: "gpt-5.2", preferredChildModel: "gpt-5.2" };
      const { session } = makeSession({ config });
      (session as any).state.providerState = {
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_stale",
        updatedAt: "2026-02-16T00:00:00.000Z",
      };

      await session.sendUserMessage("hello");

      expect(mockRunTurn).toHaveBeenCalledTimes(2);
      expect((mockRunTurn.mock.calls[0][0] as any).providerState?.responseId).toBe("resp_stale");
      expect((mockRunTurn.mock.calls[1][0] as any).providerState).toBeNull();
      expect((session as any).state.providerState).toEqual({
        provider: "openai",
        model: "gpt-5.2",
        responseId: "resp_fresh",
        updatedAt: "2026-02-16T00:00:02.000Z",
      });
    });

    test("persists Google continuation state returned by runTurn", async () => {
      const googleProviderState = {
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        interactionId: "interaction_fresh",
        updatedAt: "2026-03-18T14:00:00.000Z",
      };
      mockRunTurn.mockResolvedValueOnce({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "ok" }],
        providerState: googleProviderState,
      });

      const dir = "/tmp/test-session";
      const config = makeConfig(dir, {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      });
      const { session } = makeSession({ config });

      await session.sendUserMessage("hello");
      await flushAsyncWork();
      await flushAsyncWork();

      expect((session as any).state.providerState).toEqual(googleProviderState);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.providerState).toEqual(googleProviderState);
    });

    test("retries once when the stored Google continuation handle is rejected", async () => {
      const freshGoogleProviderState = {
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        interactionId: "interaction_fresh",
        updatedAt: "2026-03-19T18:30:00.000Z",
      };
      mockRunTurn
        .mockImplementationOnce(async () => {
          throw new Error("Invalid previous_interaction_id: interaction_id not found");
        })
        .mockImplementationOnce(async () => ({
          text: "ok",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "ok" }],
          providerState: freshGoogleProviderState,
        }));

      const dir = "/tmp/test-session";
      const config = makeConfig(dir, {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
      });
      const { session } = makeSession({ config });
      (session as any).state.providerState = {
        provider: "google",
        model: "gemini-3-flash-preview",
        interactionId: "interaction_stale",
        updatedAt: "2026-03-19T18:00:00.000Z",
      };

      await session.sendUserMessage("hello");

      expect(mockRunTurn).toHaveBeenCalledTimes(2);
      expect((mockRunTurn.mock.calls[0][0] as any).providerState?.interactionId).toBe("interaction_stale");
      expect((mockRunTurn.mock.calls[1][0] as any).providerState).toBeNull();
      expect((session as any).state.providerState).toEqual(freshGoogleProviderState);
    });

    test("persists full session context including response history", async () => {
      mockRunTurn.mockResolvedValueOnce({
        text: "assistant reply",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "assistant reply" }],
      });
      const { session } = makeSession();

      await session.sendUserMessage("persist me");
      await flushAsyncWork();

      const last = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      const snapshot = last?.snapshot;
      expect(snapshot).toBeDefined();
      expect(snapshot.context.system).toBe("You are a test assistant.");
      expect(Array.isArray(snapshot.context.messages)).toBe(true);
      expect(snapshot.context.messages.some((msg: any) => msg.role === "user")).toBe(true);
      expect(snapshot.context.messages.some((msg: any) => msg.role === "assistant")).toBe(true);
    });

    test("keeps full persisted history while capping runtime context window", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();
      const totalMessages = 205;
      for (let i = 0; i < totalMessages; i++) {
        await session.sendUserMessage(`message ${i + 1}`);
      }
      await flushAsyncWork();

      expect(session.messageCount).toBe(totalMessages);
      const lastRunTurnCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastRunTurnCall.messages.length).toBe(200);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.messages.length).toBe(totalMessages);
    });

    test("emits assistant_message when response has text", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "Here is my response.",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("Here is my response.");
      expect(assistantEvt.sessionId).toBe(session.id);
    });

    test("emits ordered model_stream_chunk events with turnId/index/provider/model", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "start" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "hel" });
        await params.onModelStreamPart?.({ type: "text-delta", id: "txt_1", text: "lo" });
        await params.onModelStreamPart?.({ type: "finish", finishReason: "stop" });
        return {
          text: "hello",
          reasoningText: "because",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const, model: "gpt-5.2" };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("hi");

      const chunks = events.filter((e) => e.type === "model_stream_chunk") as Extract<ServerEvent, { type: "model_stream_chunk" }>[];
      expect(chunks).toHaveLength(4);
      expect(chunks.map((chunk) => chunk.partType)).toEqual(["start", "text_delta", "text_delta", "finish"]);
      expect(new Set(chunks.map((chunk) => chunk.turnId)).size).toBe(1);
      expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3]);
      for (const chunk of chunks) {
        expect(chunk.sessionId).toBe(session.id);
        expect(chunk.provider).toBe("openai");
        expect(chunk.model).toBe("gpt-5.2");
      }
      expect((chunks[1]?.part.text as string) ?? "").toBe("hel");
      expect((chunks[2]?.part.text as string) ?? "").toBe("lo");

      const legacyReasoning = events.find((e) => e.type === "reasoning");
      const legacyAssistant = events.find((e) => e.type === "assistant_message");
      expect(legacyReasoning).toBeDefined();
      expect(legacyAssistant).toBeDefined();
    });

    test("does not emit assistant_message when response text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("falls back to assistant responseMessages text when stream text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Here is what I found in this folder." }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("whats in this folder");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeDefined();
      if (assistantEvt && assistantEvt.type === "assistant_message") {
        expect(assistantEvt.text).toBe("Here is what I found in this folder.");
      }
    });

    test("does not emit assistant_message when response text is only whitespace", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "   \n\t  ",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("emits reasoning event when reasoningText is present", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "I thought about this carefully.",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("think hard");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.text).toBe("I thought about this carefully.");
      expect(reasoningEvt.sessionId).toBe(session.id);
    });

    test("does not emit reasoning when reasoningText is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test("does not emit reasoning when reasoningText is undefined", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test("does not emit reasoning when reasoningText is only whitespace", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "   \n  ",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning");
      expect(reasoningEvt).toBeUndefined();
    });

    test('uses "summary" kind for openai provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.kind).toBe("summary");
    });

    test('normalizes reasoning_delta mode to "summary" for openai stream parts', async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "r1", text: "thinking" });
        return {
          text: "done",
          reasoningText: "thinking",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "openai" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk" && e.partType === "reasoning_delta") as
        | Extract<ServerEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (chunk) {
        expect(chunk.part.mode).toBe("summary");
      }
    });

    test('uses "summary" kind for codex-cli provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "codex-cli" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt).toBeDefined();
      expect(reasoningEvt.kind).toBe("summary");
    });

    test('uses "reasoning" kind for google provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "google" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt.kind).toBe("reasoning");
    });

    test('normalizes reasoning_delta mode to "reasoning" for google stream parts', async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        await params.onModelStreamPart?.({ type: "reasoning-delta", id: "r1", text: "thinking" });
        return {
          text: "done",
          reasoningText: "thinking",
          responseMessages: [],
        };
      });

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "google" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk" && e.partType === "reasoning_delta") as
        | Extract<ServerEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (chunk) {
        expect(chunk.part.mode).toBe("reasoning");
      }
    });

    test("sanitizes non-json-safe stream raw payloads", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        const cyclic: any = { name: "root", count: 12n };
        cyclic.self = cyclic;
        cyclic.items = [1, 2, 3];
        await params.onModelStreamPart?.({ type: "raw", rawValue: cyclic });
        return {
          text: "done",
          reasoningText: undefined,
          responseMessages: [],
        };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const chunk = events.find((e) => e.type === "model_stream_chunk") as
        | Extract<ServerEvent, { type: "model_stream_chunk" }>
        | undefined;
      expect(chunk).toBeDefined();
      if (!chunk) return;

      expect(chunk.partType).toBe("raw");
      expect(isRecord(chunk.part.raw)).toBe(true);
      const partRaw = chunk.part.raw as Record<string, unknown>;
      expect(partRaw.self).toBe("[circular]");
      expect(partRaw.count).toBe("12");
      expect(isRecord(chunk.rawPart)).toBe(true);
    });

    test('uses "reasoning" kind for anthropic provider', async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "answer",
        reasoningText: "my reasoning",
        responseMessages: [],
      }));

      const dir = "/tmp/test-session";
      const config = { ...makeConfig(dir), provider: "anthropic" as const };
      const { session, events } = makeSession({ config });
      await session.sendUserMessage("go");

      const reasoningEvt = events.find((e) => e.type === "reasoning") as any;
      expect(reasoningEvt.kind).toBe("reasoning");
    });

    test("catches runTurn errors and emits error event", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Model API failure");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("Model API failure");
      expect(errorEvt.sessionId).toBe(session.id);
    });

    test("classifies unknown checkpoint id failures as validation_failed", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Unknown checkpoint id: cp-404");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("classifies glob guard rejections as permission_denied", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("glob blocked: pattern cannot escape cwd");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("classifies backup errors containing invalid as backup_error", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("session backup has invalid state");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("classifies checkpoint errors as backup_error even when message includes provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("session backup checkpoint failed for provider reconnect flow");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("does not classify generic backup mentions as backup subsystem errors", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("failed to create backup before editing");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("internal_error");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("catches non-Error throws and emits error event", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw "string error";
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as any;
      expect(errorEvt).toBeDefined();
      expect(errorEvt.message).toContain("string error");
    });

    test("sets running=false even on error (finally block)", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("fail");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("first");

      events.length = 0;
      mockRunTurn.mockImplementation(async () => ({
        text: "recovered",
        reasoningText: undefined,
        responseMessages: [],
      }));

      await session.sendUserMessage("second");
      const busyError = events.find((e) => e.type === "error" && (e as any).message === "Agent is busy");
      expect(busyError).toBeUndefined();

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt.text).toBe("recovered");
    });

    test("event emission order: user_message comes before assistant_message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "response",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const userIdx = events.findIndex((e) => e.type === "user_message");
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(userIdx).toBeLessThan(assistantIdx);
    });

    test("event emission order: reasoning comes before assistant_message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "response",
        reasoningText: "thinking",
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("hi");

      const reasoningIdx = events.findIndex((e) => e.type === "reasoning");
      const assistantIdx = events.findIndex((e) => e.type === "assistant_message");
      expect(reasoningIdx).toBeLessThan(assistantIdx);
    });

    test("passes log callback that emits log events", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        params.log("doing something");
        params.log("done");
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const logEvents = events.filter((e) => e.type === "log") as any[];
      expect(logEvents).toHaveLength(2);
      expect(logEvents[0].line).toBe("doing something");
      expect(logEvents[1].line).toBe("done");
      expect(logEvents[0].sessionId).toBe(session.id);
    });

    test("messages accumulate across multiple sendUserMessage calls", async () => {
      const responseMsg1 = { role: "assistant" as const, content: "resp1" };
      const responseMsg2 = { role: "assistant" as const, content: "resp2" };

      mockRunTurn
        .mockImplementationOnce(async () => ({
          text: "resp1",
          reasoningText: undefined,
          responseMessages: [responseMsg1],
        }))
        .mockImplementationOnce(async () => ({
          text: "resp2",
          reasoningText: undefined,
          responseMessages: [responseMsg2],
        }))
        .mockImplementationOnce(async () => ({
          text: "resp3",
          reasoningText: undefined,
          responseMessages: [],
        }));

      const { session } = makeSession();
      await session.sendUserMessage("msg1");
      await session.sendUserMessage("msg2");
      await session.sendUserMessage("msg3");

      const thirdCall = mockRunTurn.mock.calls[2][0] as any;
      expect(thirdCall.messages).toHaveLength(5);
      expect(thirdCall.messages[0]).toEqual({ role: "user", content: "msg1" });
      expect(thirdCall.messages[1]).toEqual(responseMsg1);
      expect(thirdCall.messages[2]).toEqual({ role: "user", content: "msg2" });
      expect(thirdCall.messages[3]).toEqual(responseMsg2);
      expect(thirdCall.messages[4]).toEqual({ role: "user", content: "msg3" });
    });
  });

  // =========================================================================
  // updateTodos callback
  // =========================================================================

  describe("updateTodos callback", () => {
    test("updates todos array via runTurn callback", async () => {
      const todos: TodoItem[] = [
        { content: "Write tests", status: "in_progress", activeForm: "testing" },
      ];

      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos(todos);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt).toBeDefined();
      expect(todosEvt.todos).toEqual(todos);
    });

    test("emits todos event with session id", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos([]);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.sessionId).toBe(session.id);
    });

    test("multiple updateTodos calls emit multiple events", async () => {
      const todos1: TodoItem[] = [{ content: "Task 1", status: "pending", activeForm: "" }];
      const todos2: TodoItem[] = [
        { content: "Task 1", status: "completed", activeForm: "" },
        { content: "Task 2", status: "in_progress", activeForm: "coding" },
      ];

      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos(todos1);
        params.updateTodos(todos2);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const todosEvents = events.filter((e) => e.type === "todos") as any[];
      expect(todosEvents).toHaveLength(2);
      expect(todosEvents[0].todos).toEqual(todos1);
      expect(todosEvents[1].todos).toEqual(todos2);
    });

    test("reset after updateTodos clears the todos", async () => {
      const todos: TodoItem[] = [{ content: "Task", status: "pending", activeForm: "" }];

      mockRunTurn.mockImplementation(async (params: any) => {
        params.updateTodos(todos);
        return { text: "", reasoningText: undefined, responseMessages: [] };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      events.length = 0;
      session.reset();

      const todosEvt = events.find((e) => e.type === "todos") as any;
      expect(todosEvt.todos).toEqual([]);
    });
  });

  describe("session backups", () => {
    test("getSessionBackupState emits a session_backup_state event", async () => {
      const { session, events } = makeSession();
      await session.getSessionBackupState();

      const evt = events.find((e) => e.type === "session_backup_state");
      expect(evt).toBeDefined();
      if (evt && evt.type === "session_backup_state") {
        expect(evt.reason).toBe("requested");
        expect(evt.backup.status).toBe("ready");
        expect(evt.backup.checkpoints).toHaveLength(1);
        expect(evt.backup.checkpoints[0]?.trigger).toBe("initial");
      }
    });

    test("disabled sessions emit a disabled backup state with no checkpoints", async () => {
      const dir = path.join(os.tmpdir(), `session-backups-disabled-${Date.now()}`);
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          backupsEnabled: false,
        },
      });

      await session.getSessionBackupState();

      const evt = events.find((event) => event.type === "session_backup_state");
      expect(evt).toBeDefined();
      if (evt && evt.type === "session_backup_state") {
        expect(evt.backup.status).toBe("disabled");
        expect(evt.backup.backupDirectory).toBeNull();
        expect(evt.backup.checkpoints).toEqual([]);
      }
    });

    test("sendUserMessage emits auto checkpoint state after completion", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("checkpoint me");
      for (let i = 0; i < 40; i += 1) {
        if (events.some((e) => e.type === "session_backup_state" && e.reason === "auto_checkpoint")) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }

      const backupEvents = events.filter((e) => e.type === "session_backup_state") as Array<
        Extract<ServerEvent, { type: "session_backup_state" }>
      >;
      const auto = backupEvents.find((e) => e.reason === "auto_checkpoint");
      expect(auto).toBeDefined();
      if (auto) {
        expect(auto.backup.checkpoints).toHaveLength(2);
        expect(auto.backup.checkpoints[0]?.trigger).toBe("initial");
        expect(auto.backup.checkpoints[1]?.trigger).toBe("auto");
      }
    });

    test("createManualSessionCheckpoint emits manual checkpoint state", async () => {
      const { session, events } = makeSession();
      await session.createManualSessionCheckpoint();

      const manual = events.find(
        (e) => e.type === "session_backup_state" && e.reason === "manual_checkpoint"
      ) as Extract<ServerEvent, { type: "session_backup_state" }> | undefined;
      expect(manual).toBeDefined();
      if (manual) {
        expect(manual.backup.checkpoints).toHaveLength(2);
        expect(manual.backup.checkpoints[0]?.trigger).toBe("initial");
        expect(manual.backup.checkpoints[1]?.trigger).toBe("manual");
      }
    });

    test("restoreSessionBackup routes original and checkpoint restores to the backup handle", async () => {
      let restoreOriginalCalls = 0;
      const restoreCheckpointCalls: string[] = [];
      const backupFactory = mock(async (opts: SessionBackupInitOptions): Promise<SessionBackupHandle> => {
        const createdAt = new Date().toISOString();
        const checkpoints: SessionBackupPublicCheckpoint[] = [
          {
            id: "cp-0001",
            index: 1,
            createdAt,
            trigger: "initial",
            changed: false,
            patchBytes: 0,
          },
        ];

        const getState = (): SessionBackupPublicState => ({
          status: "ready",
          sessionId: opts.sessionId,
          workingDirectory: opts.workingDirectory,
          backupDirectory: `/tmp/mock-backups/${opts.sessionId}`,
          createdAt,
          originalSnapshot: { kind: "directory" },
          checkpoints: [...checkpoints],
        });

        return {
          getPublicState: () => getState(),
          createCheckpoint: async (trigger) => {
            const checkpoint: SessionBackupPublicCheckpoint = {
              id: `cp-${String(checkpoints.length + 1).padStart(4, "0")}`,
              index: checkpoints.length + 1,
              createdAt: new Date().toISOString(),
              trigger,
              changed: true,
              patchBytes: 42,
            };
            checkpoints.push(checkpoint);
            return checkpoint;
          },
          restoreOriginal: async () => {
            restoreOriginalCalls += 1;
          },
          restoreCheckpoint: async (checkpointId) => {
            restoreCheckpointCalls.push(checkpointId);
            if (!checkpoints.some((cp) => cp.id === checkpointId)) {
              throw new Error(`Unknown checkpoint: ${checkpointId}`);
            }
          },
          deleteCheckpoint: async () => false,
          reloadFromDisk: async () => getState(),
          close: async () => {},
        };
      });

      const { session, events } = makeSession({ sessionBackupFactory: backupFactory });
      await session.createManualSessionCheckpoint();
      await session.restoreSessionBackup();
      await session.restoreSessionBackup("cp-0001");

      expect(restoreOriginalCalls).toBe(1);
      expect(restoreCheckpointCalls).toEqual(["cp-0001"]);
      const restoreEvents = events.filter(
        (e) => e.type === "session_backup_state" && e.reason === "restore"
      ) as Array<Extract<ServerEvent, { type: "session_backup_state" }>>;
      expect(restoreEvents).toHaveLength(2);
      expect(restoreEvents.every((evt) => evt.backup.status === "ready")).toBe(true);
    });

    test("deleteSessionCheckpoint emits error when checkpoint does not exist", async () => {
      const { session, events } = makeSession();
      await session.deleteSessionCheckpoint("does-not-exist");

      const err = events.find((e) => e.type === "error");
      expect(err).toBeDefined();
      if (err && err.type === "error") {
        expect(err.message).toContain("Unknown checkpoint id");
      }
    });

    test("manual checkpoint requests are serialized", async () => {
      const { session, events } = makeSession();

      await Promise.all([session.createManualSessionCheckpoint(), session.createManualSessionCheckpoint()]);

      const manualEvents = events.filter(
        (e) => e.type === "session_backup_state" && e.reason === "manual_checkpoint"
      ) as Array<Extract<ServerEvent, { type: "session_backup_state" }>>;
      expect(manualEvents.length).toBe(2);
      expect(manualEvents[1]?.backup.checkpoints.length).toBe(3);
    });
  });

  // =========================================================================
  // Edge cases / Integration
  // =========================================================================

  describe("Edge cases", () => {
    test("sendUserMessage with empty string still processes", async () => {
      const { session, events } = makeSession();
      await session.sendUserMessage("");

      const userEvt = events.find((e) => e.type === "user_message") as any;
      expect(userEvt.text).toBe("");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });

    test("reset during idle state does not throw", () => {
      const { session } = makeSession();
      expect(() => session.reset()).not.toThrow();
    });

    test("dispose then sendUserMessage works (running is false after dispose)", async () => {
      const { session } = makeSession();
      session.dispose("test");

      await session.sendUserMessage("after dispose");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // classifyTurnError — error code routing
  // =========================================================================

  describe("classifyTurnError error code routing", () => {
    test("'blocked: path is outside' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked: path is outside the allowed directory");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked: canonical target resolves outside' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked: canonical target resolves outside allowed directories");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'outside allowed directories' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Write target is outside allowed directories");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked private/internal host' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked private/internal host 192.168.1.1");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'blocked url protocol' maps to permission_denied / permissions", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("blocked url protocol ftp");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("'oauth' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("OAuth token exchange failed");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'api key' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Invalid API key provided");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'unsupported provider' maps to provider_error / provider", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Unsupported provider: foobar");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("'checkpoint' (without 'unknown checkpoint id') maps to backup_error / backup", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("checkpoint creation timed out");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("backup_error");
        expect(errorEvt.source).toBe("backup");
      }
    });

    test("'unknown checkpoint id' maps to validation_failed / session (higher priority than checkpoint)", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("unknown checkpoint id: cp-9999");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'is required' maps to validation_failed / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Parameter 'filename' is required");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'invalid ' maps to validation_failed / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("invalid configuration value for maxTokens");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("'observability' maps to observability_error / observability", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("observability endpoint unreachable");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("observability_error");
        expect(errorEvt.source).toBe("observability");
      }
    });

    test("structured error code/source is routed without message matching", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw { code: "provider_error", source: "provider", message: "Token exchange failed" };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("provider_error");
        expect(errorEvt.source).toBe("provider");
      }
    });

    test("structured error code without source falls back to default source mapping", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw { code: "permission_denied", message: "Denied" };
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("permission_denied");
        expect(errorEvt.source).toBe("permissions");
      }
    });

    test("unclassified error maps to internal_error / session", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Something completely unexpected happened");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("internal_error");
        expect(errorEvt.source).toBe("session");
      }
    });

    test("session_busy outcome is 'error' for classified errors", async () => {
      mockRunTurn.mockImplementation(async () => {
        throw new Error("Invalid API key");
      });

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const busyFalse = events.find(
        (e) => e.type === "session_busy" && !(e as any).busy
      ) as any;
      expect(busyFalse).toBeDefined();
      expect(busyFalse.outcome).toBe("error");
    });
  });

  // =========================================================================
  // Token usage passthrough
  // =========================================================================

  describe("Token usage passthrough", () => {
    test("emits turn_usage event when runTurn returns usage", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedPromptTokens: 25,
          estimatedCostUsd: 0.1234,
        },
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const usageEvt = events.find((e) => e.type === "turn_usage") as Extract<ServerEvent, { type: "turn_usage" }> | undefined;
      expect(usageEvt).toBeDefined();
      if (usageEvt) {
        expect(usageEvt.sessionId).toBe(session.id);
        expect(usageEvt.usage.promptTokens).toBe(100);
        expect(usageEvt.usage.completionTokens).toBe(50);
        expect(usageEvt.usage.totalTokens).toBe(150);
        expect(usageEvt.usage.cachedPromptTokens).toBe(25);
        expect(usageEvt.usage.estimatedCostUsd).toBe(0.1234);
        expect(typeof usageEvt.turnId).toBe("string");
        expect(usageEvt.turnId.length).toBeGreaterThan(0);
      }
    });

    test("does not emit turn_usage when runTurn returns no usage", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const usageEvt = events.find((e) => e.type === "turn_usage");
      expect(usageEvt).toBeUndefined();
    });

    test("turn_usage event has matching turnId with session_busy events", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "done",
        reasoningText: undefined,
        responseMessages: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const busyTrue = events.find((e) => e.type === "session_busy" && (e as any).busy === true) as any;
      const usageEvt = events.find((e) => e.type === "turn_usage") as any;
      expect(busyTrue).toBeDefined();
      expect(usageEvt).toBeDefined();
      expect(usageEvt.turnId).toBe(busyTrue.turnId);
    });
  });

  // =========================================================================
  // MAX_MESSAGE_HISTORY truncation
  // =========================================================================

  describe("MAX_MESSAGE_HISTORY truncation", () => {
    test("runtime messages are capped at 200 while allMessages grows unbounded", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      // Send 205 messages (each adds 1 user message to history)
      for (let i = 0; i < 205; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      // allMessages should hold all 205 user messages
      expect(session.messageCount).toBe(205);

      // The runtime messages passed to runTurn should be capped at 200
      const lastCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastCall.messages.length).toBe(200);
    });

    test("truncated runtime window keeps first message plus last 199", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      for (let i = 0; i < 205; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      const lastCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;

      // First message in the window should be the very first user message ever sent
      expect(lastCall.messages[0]).toEqual({ role: "user", content: "msg-0" });

      // Last message should be the most recent
      expect(lastCall.messages[199]).toEqual({ role: "user", content: "msg-204" });

      // Second message in the window should be msg-6 (the 7th overall),
      // since first + last 199 = msg-0, msg-6..msg-204
      expect(lastCall.messages[1]).toEqual({ role: "user", content: "msg-6" });
    });

    test("messages at exactly 200 are not truncated", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      for (let i = 0; i < 200; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      const lastCall = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(lastCall.messages.length).toBe(200);
      expect(lastCall.messages[0]).toEqual({ role: "user", content: "msg-0" });
      expect(lastCall.messages[199]).toEqual({ role: "user", content: "msg-199" });
    });

    test("persisted snapshot keeps all messages even when runtime is truncated", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [],
      }));

      const { session } = makeSession();

      for (let i = 0; i < 205; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }
      await flushAsyncWork();

      expect(session.messageCount).toBe(205);
      const lastPersistCall = mockWritePersistedSessionSnapshot.mock.calls.at(-1)?.[0] as any;
      expect(lastPersistCall.snapshot.context.messages.length).toBe(205);
    });

    test("truncation with response messages counts both user and assistant messages", async () => {
      let callNum = 0;
      let capturedMessagesLength = 0;
      let capturedFirstMessage: any = null;
      let capturedLastMessage: any = null;
      mockRunTurn.mockImplementation(async (params: any) => {
        callNum++;
        // Capture length at call time (before response messages mutate the array)
        capturedMessagesLength = params.messages.length;
        capturedFirstMessage = params.messages[0];
        capturedLastMessage = params.messages[params.messages.length - 1];
        return {
          text: "",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: `reply-${callNum}` }],
        };
      });

      const { session } = makeSession();

      // Each sendUserMessage adds 1 user msg + 1 assistant msg = 2 per call
      // After 110 calls: 220 messages total (exceeds 200)
      for (let i = 0; i < 110; i++) {
        await session.sendUserMessage(`msg-${i}`);
      }

      // Total messages: 220 (110 user + 110 assistant)
      expect(session.messageCount).toBe(220);

      // Runtime window at the time of the last runTurn call should be capped at 200
      expect(capturedMessagesLength).toBe(200);

      // First message is preserved
      expect(capturedFirstMessage).toEqual({ role: "user", content: "msg-0" });

      // Last message is the user message for the latest call
      expect(capturedLastMessage).toEqual({ role: "user", content: "msg-109" });
    });
  });

  describe("session cost tracking", () => {
    test("blocks new turns once the hard-stop budget has been exceeded", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
      }));

      const dir = "/tmp/test-session-budget";
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      await session.sendUserMessage("first");
      expect(mockRunTurn.mock.calls.length).toBe(1);

      const tracker = (session as any).state.costTracker;
      tracker.setBudget({ stopAtUsd: 0.001 });
      events.length = 0;

      await session.sendUserMessage("second");

      expect(mockRunTurn.mock.calls.length).toBe(1);
      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      if (errorEvt) {
        expect(errorEvt.code).toBe("validation_failed");
        expect(errorEvt.source).toBe("session");
        expect(errorEvt.message).toContain("hard-stop budget");
      }
      expect(events.some((e) => e.type === "user_message")).toBe(false);
    });

    test("allows direct budget updates to recover after a hard-stop lockout", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
      }));

      const dir = "/tmp/test-session-budget-recovery";
      const { session, events } = makeSession({
        config: {
          ...makeConfig(dir),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      await session.sendUserMessage("first");
      const tracker = (session as any).state.costTracker;
      tracker.setBudget({ stopAtUsd: 0.001 });

      events.length = 0;
      session.setSessionUsageBudget(20, null);

      const usageEvt = events.find((e) => e.type === "session_usage") as Extract<ServerEvent, { type: "session_usage" }> | undefined;
      expect(usageEvt).toBeDefined();
      if (usageEvt?.usage) {
        expect(usageEvt.usage.budgetStatus.stopAtUsd).toBeNull();
        expect(usageEvt.usage.budgetStatus.warnAtUsd).toBe(20);
      }

      events.length = 0;
      await session.sendUserMessage("second");

      expect(mockRunTurn.mock.calls.length).toBe(2);
      expect(events.some((e) => e.type === "user_message")).toBe(true);
    });

    test("emits compact session_usage snapshots after completed turns", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1000,
          completionTokens: 100,
          totalTokens: 1100,
        },
      }));

      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session-compact-usage"),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      for (let i = 0; i < 10; i += 1) {
        await session.sendUserMessage(`turn ${i + 1}`);
      }

      const usageEvt = events.findLast((e) => e.type === "session_usage") as Extract<ServerEvent, { type: "session_usage" }> | undefined;
      expect(usageEvt).toBeDefined();
      expect(usageEvt?.usage?.totalTurns).toBe(10);
      expect(usageEvt?.usage?.turns).toHaveLength(8);
      expect(usageEvt?.usage?.turns[0]?.turnId).toBeDefined();
      expect(usageEvt?.usage?.turns.at(-1)?.turnId).toBeDefined();
    });

    test("emits proactive budget alert events when a turn crosses warning and stop thresholds", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "ok",
        reasoningText: undefined,
        responseMessages: [],
        usage: {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
      }));

      const { session, events } = makeSession({
        config: {
          ...makeConfig("/tmp/test-session-budget-alerts"),
          provider: "openai",
          model: "gpt-5.2",
          preferredChildModel: "gpt-5.2",
        },
      });

      session.setSessionUsageBudget(1, 2);
      events.length = 0;

      await session.sendUserMessage("first");

      const warningEvt = events.find((e) => e.type === "budget_warning") as Extract<ServerEvent, { type: "budget_warning" }> | undefined;
      expect(warningEvt).toBeDefined();
      expect(warningEvt?.currentCostUsd).toBe(15.75);
      expect(warningEvt?.thresholdUsd).toBe(1);

      const exceededEvt = events.find((e) => e.type === "budget_exceeded") as Extract<ServerEvent, { type: "budget_exceeded" }> | undefined;
      expect(exceededEvt).toBeDefined();
      expect(exceededEvt?.currentCostUsd).toBe(15.75);
      expect(exceededEvt?.thresholdUsd).toBe(2);

      const costLogs = events
        .filter((e): e is Extract<ServerEvent, { type: "log" }> => e.type === "log")
        .map((e) => e.line);
      expect(costLogs.some((line) => line.includes("Budget warning"))).toBe(true);
      expect(costLogs.some((line) => line.includes("Budget exceeded"))).toBe(true);
    });

    test("persists usage budget updates immediately", async () => {
      const { session } = makeSession();
      const persistedReasons: string[] = [];
      (session as any).persistenceManager.queuePersistSessionSnapshot = (reason: string) => {
        persistedReasons.push(reason);
      };

      session.setSessionUsageBudget(2, 5);

      expect(persistedReasons).toEqual(["session.usage_budget_updated"]);
    });

    test("preserves unspecified budget thresholds when updating session usage budget", async () => {
      const { session, events } = makeSession();
      const tracker = (session as any).state.costTracker as SessionCostTracker;
      tracker.updateBudget({ warnAtUsd: 2, stopAtUsd: 5 });

      session.setSessionUsageBudget(undefined, null);

      const usageEvt = events.find((e) => e.type === "session_usage") as Extract<ServerEvent, { type: "session_usage" }> | undefined;
      expect(usageEvt?.usage?.budgetStatus).toMatchObject({
        warnAtUsd: 2,
        stopAtUsd: null,
      });
    });

    test("rejects merged budget updates that would invalidate the existing hard stop", async () => {
      const { session, events } = makeSession();
      const tracker = (session as any).state.costTracker as SessionCostTracker;
      tracker.updateBudget({ warnAtUsd: 2, stopAtUsd: 5 });

      session.setSessionUsageBudget(6, undefined);

      const errorEvt = events.find((e) => e.type === "error") as Extract<ServerEvent, { type: "error" }> | undefined;
      expect(errorEvt).toBeDefined();
      expect(errorEvt?.code).toBe("validation_failed");
      expect(errorEvt?.message).toContain("Warning threshold must be less than the hard-stop threshold.");

      const usageEvt = events.find((e) => e.type === "session_usage");
      expect(usageEvt).toBeUndefined();
      expect(tracker.getBudgetStatus()).toMatchObject({
        warnAtUsd: 2,
        stopAtUsd: 5,
      });
    });

    test("returns a compact session usage snapshot on explicit request after resume", () => {
      const tracker = new SessionCostTracker("persisted-session");
      for (let i = 0; i < 10; i += 1) {
        tracker.recordTurn({
          turnId: `turn-${i + 1}`,
          provider: "openai",
          model: "gpt-5.2",
          usage: {
            promptTokens: 100,
            completionTokens: 25,
            totalTokens: 125,
          },
        });
      }
      tracker.updateBudget({ warnAtUsd: 3, stopAtUsd: 6 });
      const { emit, events } = makeEmit();

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-session",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Persisted",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          enableMcp: true,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: tracker.getSnapshot(),
        },
        baseConfig: makeConfig("/tmp/persisted"),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      session.getSessionUsage();

      const usageEvt = events.find((e) => e.type === "session_usage") as Extract<ServerEvent, { type: "session_usage" }> | undefined;
      expect(usageEvt?.usage).toEqual(tracker.getCompactSnapshot());
      expect(usageEvt?.usage?.totalTurns).toBe(10);
      expect(usageEvt?.usage?.turns).toHaveLength(8);
      expect(usageEvt?.usage?.turns[0]?.turnId).toBe("turn-3");
      expect(usageEvt?.usage?.turns.at(-1)?.turnId).toBe("turn-10");
    });

    test("rehydrates persisted errored child sessions with an error runtime outcome", () => {
      const { emit } = makeEmit();

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-child-error",
          sessionKind: "agent",
          parentSessionId: "root-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          nickname: null,
          requestedModel: null,
          effectiveModel: "gpt-5.2",
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: "errored",
          lastMessagePreview: "Task failed",
          title: "Persisted child",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          outputDirectory: undefined,
          uploadsDirectory: undefined,
          enableMcp: true,
          backupsEnabledOverride: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      expect(session.currentTurnOutcome).toBe("error");
      expect(session.getSessionInfoEvent().executionState).toBe("errored");
    });

    test("rehydrates stale in-flight child execution states as completed when no turn is active", () => {
      for (const executionState of ["running", "pending_init"] as const) {
        const { emit } = makeEmit();

        const session = AgentSession.fromPersisted({
          persisted: {
            sessionId: `persisted-child-${executionState}`,
            sessionKind: "agent",
            parentSessionId: "root-1",
            role: "worker",
            mode: "collaborative",
            depth: 1,
            nickname: null,
            requestedModel: null,
            effectiveModel: "gpt-5.2",
            requestedReasoningEffort: null,
            effectiveReasoningEffort: null,
            executionState,
            lastMessagePreview: "Task was in progress",
            title: "Persisted child",
            titleSource: "manual",
            titleModel: null,
            provider: "openai",
            model: "gpt-5.2",
            workingDirectory: "/tmp/persisted",
            outputDirectory: undefined,
            uploadsDirectory: undefined,
            enableMcp: true,
            backupsEnabledOverride: null,
            createdAt: "2026-03-09T00:00:00.000Z",
            updatedAt: "2026-03-09T00:00:01.000Z",
            status: "active",
            hasPendingAsk: false,
            hasPendingApproval: false,
            messageCount: 1,
            lastEventSeq: 1,
            systemPrompt: "system",
            messages: [{ role: "user", content: "hello" }] as any,
            providerState: null,
            todos: [],
            harnessContext: null,
            costTracker: null,
          },
          baseConfig: makeConfig("/tmp/persisted"),
          emit,
          sessionBackupFactory: makeSessionBackupFactory(),
          getProviderStatusesImpl: async () => [],
        });

        expect(session.currentTurnOutcome).toBe("completed");
        expect(session.getSessionInfoEvent().executionState).toBe("completed");
      }
    });

    test("restores persisted providerOptions into resumed runtime config", async () => {
      const { emit } = makeEmit();
      const providerOptions = {
        openai: {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      };

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-provider-options",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Persisted",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/persisted",
          outputDirectory: undefined,
          uploadsDirectory: undefined,
          providerOptions,
          enableMcp: true,
          backupsEnabledOverride: null,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: null,
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
      });

      await session.sendUserMessage("question");

      const call = mockRunTurn.mock.calls.at(-1)?.[0] as any;
      expect(call.config.providerOptions).toEqual(providerOptions);
    });

    test("migrates unsupported persisted models to provider default and persists the upgraded snapshot", async () => {
      const { emit, events } = makeEmit();
      const writePersistedSessionSnapshotImpl = mock(async () => "/tmp/mock-home/.cowork/sessions/persisted-upgraded.json");
      const persistedModel = "gpt-5.3-codex";
      const expectedModel = defaultSupportedModel("openai").id;

      const session = AgentSession.fromPersisted({
        persisted: {
          sessionId: "persisted-legacy-model",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          title: "Legacy",
          titleSource: "manual",
          titleModel: null,
          provider: "openai",
          model: persistedModel,
          workingDirectory: "/tmp/persisted",
          enableMcp: true,
          createdAt: "2026-03-09T00:00:00.000Z",
          updatedAt: "2026-03-09T00:00:01.000Z",
          status: "active",
          hasPendingAsk: false,
          hasPendingApproval: false,
          messageCount: 1,
          lastEventSeq: 1,
          systemPrompt: "system",
          messages: [{ role: "user", content: "hello" }] as any,
          providerState: {
            provider: "openai",
            model: persistedModel,
            responseId: "resp_legacy",
            updatedAt: "2026-03-09T00:00:01.000Z",
          },
          todos: [],
          harnessContext: null,
          costTracker: null,
        },
        baseConfig: makeConfig("/tmp/persisted"),
        emit,
        sessionBackupFactory: makeSessionBackupFactory(),
        getProviderStatusesImpl: async () => [],
        writePersistedSessionSnapshotImpl,
      });

      expect(session.getPublicConfig().provider).toBe("openai");
      expect(session.getPublicConfig().model).toBe(expectedModel);
      expect(session.getSessionInfoEvent().model).toBe(expectedModel);

      const migrationLog = events.find(
        (event): event is Extract<ServerEvent, { type: "log" }> =>
          event.type === "log" && event.line.includes("unsupported model")
      );
      expect(migrationLog).toBeDefined();
      expect(migrationLog?.line).toContain(`"${persistedModel}"`);
      expect(migrationLog?.line).toContain(`"${expectedModel}"`);
      expect(migrationLog?.line).toContain("Cleared saved continuation state");

      await flushAsyncWork();
      await flushAsyncWork();

      expect(writePersistedSessionSnapshotImpl).toHaveBeenCalledTimes(1);
      const persistedCall = writePersistedSessionSnapshotImpl.mock.calls[0]?.[0] as {
        snapshot: {
          session: { model: string };
          config: { model: string };
          context: { providerState: unknown };
        };
      };
      expect(persistedCall.snapshot.session.model).toBe(expectedModel);
      expect(persistedCall.snapshot.config.model).toBe(expectedModel);
      expect(persistedCall.snapshot.context.providerState).toBeNull();
    });
  });
  // =========================================================================
  // extractAssistantTextFromResponseMessages fallback
  // =========================================================================

  describe("extractAssistantTextFromResponseMessages fallback", () => {
    test("falls back to output_text parts from responseMessages when text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "fallback text from output_text" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("fallback text from output_text");
    });

    test("falls back to text parts from responseMessages when stream text is empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "fallback text from text part" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("fallback text from text part");
    });

    test("concatenates multiple text chunks from a single assistant message", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "first chunk" },
              { type: "output_text", text: " second chunk" },
            ],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("first chunk second chunk");
    });

    test("concatenates text from multiple assistant messages with double newline", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "message one" }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "message two" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("message one\n\nmessage two");
    });

    test("ignores commentary-phase assistant text in the fallback", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "progress", phase: "commentary" }],
          },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "final answer", phase: "final_answer" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("final answer");
    });

    test("ignores non-text/non-output_text parts in the fallback", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "read_file", input: {} },
              { type: "output_text", text: "actual text" },
            ],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("actual text");
    });

    test("does not emit assistant_message when both text and responseMessages have no text", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "bash", input: { command: "ls" } }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message");
      expect(assistantEvt).toBeUndefined();
    });

    test("prefers stream text over fallback when stream text is non-empty", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "primary stream text",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "fallback text" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("primary stream text");
    });

    test("falls back when text is whitespace-only", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "   \n\t  ",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: [{ type: "output_text", text: "fallback after whitespace" }],
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("fallback after whitespace");
    });

    test("handles string content in assistant responseMessages", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "",
        reasoningText: undefined,
        responseMessages: [
          {
            role: "assistant",
            content: "simple string content",
          },
        ],
      }));

      const { session, events } = makeSession();
      await session.sendUserMessage("go");

      const assistantEvt = events.find((e) => e.type === "assistant_message") as any;
      expect(assistantEvt).toBeDefined();
      expect(assistantEvt.text).toBe("simple string content");
    });

    test("passes agentControl to root session turns when child-session callbacks exist", async () => {
      mockRunTurn.mockImplementation(async (params: any) => {
        expect(params.agentControl).toBeDefined();
        expect(typeof params.agentControl.spawn).toBe("function");
        expect(typeof params.agentControl.list).toBe("function");
        expect(typeof params.agentControl.sendInput).toBe("function");
        expect(typeof params.agentControl.wait).toBe("function");
        expect(typeof params.agentControl.close).toBe("function");
        return {
          text: "ok",
          reasoningText: undefined,
          responseMessages: [{ role: "assistant", content: "ok" }],
        };
      });

      const createAgentSessionImpl = mock(async () => ({
        sessionId: "sub-1",
        parentSessionId: "parent-1",
        role: "worker" as const,
        title: "Child",
        provider: "google" as const,
        model: "gemini-3-flash-preview",
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
        status: "active" as const,
        busy: true,
      }));

      const { session } = makeSession({
        createAgentSessionImpl,
        listAgentSessionsImpl: async () => [],
        sendAgentInputImpl: async () => {},
        waitForAgentImpl: async () => ({ sessionId: "sub-1", status: "completed" as const, busy: false }),
        closeAgentImpl: async () => ({
          sessionId: "sub-1",
          parentSessionId: "parent-1",
          role: "worker" as const,
          title: "Child",
          provider: "google" as const,
          model: "gemini-3-flash-preview",
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          status: "closed" as const,
          busy: false,
        }),
      });

      await session.sendUserMessage("go");
      expect(mockRunTurn).toHaveBeenCalledTimes(1);
    });

    test("reopens a closed session when new input arrives", async () => {
      mockRunTurn.mockImplementation(async () => ({
        text: "reopened",
        reasoningText: undefined,
        responseMessages: [{ role: "assistant", content: "reopened" }],
      }));

      const { session } = makeSession();
      await session.closeForHistory();
      expect((session as any).state.persistenceStatus).toBe("closed");

      await session.sendUserMessage("reopen me");

      expect((session as any).state.persistenceStatus).toBe("active");
    });
  });
});
