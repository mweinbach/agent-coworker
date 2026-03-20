import { describe, expect, test } from "bun:test";

import type { SessionContext } from "../src/server/session/SessionContext";
import { HistoryManager } from "../src/server/session/HistoryManager";
import { McpManager } from "../src/server/session/McpManager";
import { SessionAdminManager } from "../src/server/session/SessionAdminManager";
import { SessionMetadataManager } from "../src/server/session/SessionMetadataManager";

function makeBaseContext(): SessionContext {
  return {
    id: "session-1",
    state: {
      config: {
        provider: "google",
        model: "gemini-3-flash-preview",
        preferredChildModel: "gemini-3-flash-preview",
        workingDirectory: "/tmp/project",
        userName: "",
        knowledgeCutoff: "unknown",
        projectAgentDir: "/tmp/project/.agent",
        userAgentDir: "/tmp/.agent",
        builtInDir: "/tmp/project",
        builtInConfigDir: "/tmp/project/config",
        skillsDirs: [],
        memoryDirs: [],
        configDirs: [],
        enableMcp: true,
      },
      system: "system",
      discoveredSkills: [],
      yolo: false,
      messages: [],
      allMessages: [],
      running: false,
      connecting: false,
      abortController: null,
      currentTurnId: null,
      currentTurnOutcome: "completed",
      maxSteps: 100,
      todos: [],
      sessionInfo: {
        title: "New Session",
        titleSource: "default",
        titleModel: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        provider: "google",
        model: "gemini-3-flash-preview",
      },
      persistenceStatus: "active",
      hasGeneratedTitle: false,
      sessionBackup: null,
      sessionBackupState: {
        status: "initializing",
        sessionId: "session-1",
        workingDirectory: "/tmp/project",
        backupDirectory: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        originalSnapshot: { kind: "pending" },
        checkpoints: [],
      },
      sessionBackupInit: null,
      backupOperationQueue: Promise.resolve(),
      lastAutoCheckpointAt: 0,
    },
    deps: {
      connectProviderImpl: async () => ({ ok: true, provider: "google", mode: "api_key", message: "ok" } as any),
      getAiCoworkerPathsImpl: () => ({ sessionsDir: "/tmp/sessions" } as any),
      getProviderCatalogImpl: async () => ({ all: [], default: {}, connected: [] }),
      getProviderStatusesImpl: async () => [],
      sessionBackupFactory: async () => ({ getPublicState: () => ({}), reloadFromDisk: async () => ({}) } as any),
      harnessContextStore: {
        get: () => null,
        set: (_id: string, value: any) => value,
        clear: () => {},
      } as any,
      runTurnImpl: async () => ({ text: "", responseMessages: [] }),
      generateSessionTitleImpl: async () => ({ title: "Generated", source: "heuristic", model: null }),
      sessionDb: null,
      writePersistedSessionSnapshotImpl: async () => undefined,
    },
    emit: () => {},
    emitError: () => {},
    emitTelemetry: () => {},
    formatError: (err) => String(err),
    guardBusy: () => true,
    getCoworkPaths: () => ({ sessionsDir: "/tmp/sessions" } as any),
    runProviderConnect: async () => ({ ok: true, provider: "google", mode: "api_key", message: "ok" } as any),
    getMcpServerByName: async () => null,
    queuePersistSessionSnapshot: () => {},
    updateSessionInfo: () => {},
    emitConfigUpdated: () => {},
    refreshProviderStatus: async () => {},
    emitProviderCatalog: async () => {},
  };
}

describe("session managers", () => {
  test("HistoryManager keeps first + last 199 runtime messages", () => {
    const context = makeBaseContext();
    context.state.allMessages = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m-${i}`,
    })) as any;
    const manager = new HistoryManager(context);

    manager.refreshRuntimeMessagesFromHistory();

    expect(context.state.messages.length).toBe(200);
    expect((context.state.messages[0] as any).content).toBe("m-0");
    expect((context.state.messages[199] as any).content).toBe("m-249");
  });

  test("SessionMetadataManager setSessionTitle updates info and queues persistence", () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    const persistedReasons: string[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.queuePersistSessionSnapshot = (reason) => persistedReasons.push(reason);
    const manager = new SessionMetadataManager(context);

    manager.setSessionTitle("  Refactor Session  ");

    expect(context.state.hasGeneratedTitle).toBe(true);
    expect(context.state.sessionInfo.title).toBe("Refactor Session");
    expect(context.state.sessionInfo.titleSource).toBe("manual");
    expect(persistedReasons).toContain("session_info.updated");
    expect(emitted.some((evt) => evt.type === "session_info")).toBe(true);
  });

  test("McpManager validate emits error event when lookup throws and clears connecting", async () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.getMcpServerByName = async () => {
      throw new Error("lookup failed");
    };
    const manager = new McpManager(context);

    await manager.validate("demo");

    const evt = emitted.find((entry) => entry.type === "mcp_server_validation");
    expect(evt).toBeDefined();
    expect(evt.ok).toBe(false);
    expect(String(evt.message)).toContain("lookup failed");
    expect(context.state.connecting).toBe(false);
  });

  test("SessionAdminManager listSessions keeps live running sessions visible when persisted summaries lag", async () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.deps.sessionDb = {
      listSessions: () => [{
        sessionId: "live-root",
        title: "New Session",
        titleSource: "default",
        titleModel: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 0,
        lastEventSeq: 1,
        hasPendingAsk: false,
        hasPendingApproval: false,
      }],
    } as any;
    context.deps.getLiveSessionSnapshotImpl = () => ({
      sessionId: "live-root",
      title: "New Session",
      titleSource: "default",
      titleModel: null,
      provider: "google",
      model: "gemini-3-flash-preview",
      sessionKind: "root",
      parentSessionId: null,
      role: null,
      mode: null,
      depth: null,
      nickname: null,
      requestedModel: null,
      effectiveModel: null,
      requestedReasoningEffort: null,
      effectiveReasoningEffort: null,
      executionState: "running",
      lastMessagePreview: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:10.000Z",
      messageCount: 1,
      lastEventSeq: 2,
      feed: [],
      agents: [],
      todos: [],
      sessionUsage: null,
      lastTurnUsage: null,
      hasPendingAsk: false,
      hasPendingApproval: false,
    });

    const manager = new SessionAdminManager(context);
    await manager.listSessions("workspace");

    expect(emitted).toContainEqual({
      type: "sessions",
      sessionId: "session-1",
      sessions: [{
        sessionId: "live-root",
        title: "New Session",
        titleSource: "default",
        titleModel: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:10.000Z",
        messageCount: 1,
        lastEventSeq: 2,
        hasPendingAsk: false,
        hasPendingApproval: false,
      }],
    });
  });

  test("SessionAdminManager listSessions hides the active idle session when other meaningful sessions exist", async () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.deps.sessionDb = {
      listSessions: () => [
        {
          sessionId: "session-1",
          title: "New Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 0,
          lastEventSeq: 1,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
        {
          sessionId: "existing-root",
          title: "Existing session",
          titleSource: "manual",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          createdAt: "2025-12-31T23:59:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 1,
          lastEventSeq: 2,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      ],
    } as any;
    context.deps.getLiveSessionSnapshotImpl = (sessionId) => sessionId === "session-1"
      ? {
          sessionId: "session-1",
          title: "New Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          mode: null,
          depth: null,
          nickname: null,
          requestedModel: null,
          effectiveModel: null,
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: null,
          lastMessagePreview: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:10.000Z",
          messageCount: 0,
          lastEventSeq: 1,
          feed: [],
          agents: [],
          todos: [],
          sessionUsage: null,
          lastTurnUsage: null,
          hasPendingAsk: false,
          hasPendingApproval: false,
        }
      : null;

    const manager = new SessionAdminManager(context);
    await manager.listSessions("workspace");

    expect(emitted).toContainEqual({
      type: "sessions",
      sessionId: "session-1",
      sessions: [{
        sessionId: "existing-root",
        title: "Existing session",
        titleSource: "manual",
        titleModel: null,
        provider: "google",
        model: "gemini-3-flash-preview",
        createdAt: "2025-12-31T23:59:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 1,
        lastEventSeq: 2,
        hasPendingAsk: false,
        hasPendingApproval: false,
      }],
    });
  });

  test("SessionAdminManager listSessions hides the active idle session when it is the only placeholder session", async () => {
    const context = makeBaseContext();
    const emitted: any[] = [];
    context.emit = (evt) => emitted.push(evt);
    context.deps.sessionDb = {
      listSessions: () => [
        {
          sessionId: "session-1",
          title: "New Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 0,
          lastEventSeq: 1,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      ],
    } as any;
    context.deps.getLiveSessionSnapshotImpl = (sessionId) => sessionId === "session-1"
      ? {
          sessionId: "session-1",
          title: "New Session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3-flash-preview",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          mode: null,
          depth: null,
          nickname: null,
          requestedModel: null,
          effectiveModel: null,
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: null,
          lastMessagePreview: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:10.000Z",
          messageCount: 0,
          lastEventSeq: 1,
          feed: [],
          agents: [],
          todos: [],
          sessionUsage: null,
          lastTurnUsage: null,
          hasPendingAsk: false,
          hasPendingApproval: false,
        }
      : null;

    const manager = new SessionAdminManager(context);
    await manager.listSessions("workspace");

    expect(emitted).toContainEqual({
      type: "sessions",
      sessionId: "session-1",
      sessions: [],
    });
  });
});
