import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: any) => any | Promise<any>>();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void }) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    const handler = jsonRpcHandlers.get(method);
    if (!handler) {
      return {};
    }
    return await handler(params);
  }

  respond() {
    return true;
  }

  close() {
    this.opts.onClose?.();
  }

  reopen() {
    this.opts.onOpen?.();
  }
}

const readTranscriptCalls: string[] = [];
const deleteTranscriptCalls: string[] = [];

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};
const MOCK_UPDATE_STATE = {
  phase: "idle",
  currentVersion: "0.1.0",
  packaged: false,
  lastCheckedAt: null,
  release: null,
  progress: null,
  error: null,
};

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async ({ threadId }: { threadId: string }) => {
    deleteTranscriptCalls.push(threadId);
  },
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async ({ threadId }: { threadId: string }) => {
    readTranscriptCalls.push(threadId);
    return [
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId,
        direction: "server",
        payload: { type: "assistant_message", text: "Transcript fallback reply" },
      },
    ];
  },
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
  showContextMenu: async () => null,
  windowMinimize: async () => {},
  windowMaximize: async () => {},
  windowClose: async () => {},
  getPlatform: async () => "linux",
  readFile: async () => "",
  previewOSFile: async () => {},
  openPath: async () => {},
  revealPath: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  renamePath: async () => {},
  trashPath: async () => {},
  confirmAction: async () => true,
  showNotification: async () => true,
  getSystemAppearance: async () => MOCK_SYSTEM_APPEARANCE,
  setWindowAppearance: async () => MOCK_SYSTEM_APPEARANCE,
  getUpdateState: async () => MOCK_UPDATE_STATE,
  checkForUpdates: async () => {},
  quitAndInstallUpdate: async () => {},
  onSystemAppearanceChanged: () => () => {},
  onMenuCommand: () => () => {},
  onUpdateStateChanged: () => () => {},
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {},
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME, defaultThreadRuntime } = await import("../src/app/store.helpers");

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function canonicalThreadId(sessionId: string, fallbackThreadId?: string): string {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) =>
    item.id === sessionId
    || item.sessionId === sessionId
    || (fallbackThreadId ? item.legacyTranscriptId === fallbackThreadId : false),
  );
  return thread?.id ?? state.selectedThreadId ?? fallbackThreadId ?? sessionId;
}

function threadMeta(sessionId: string) {
  return {
    id: sessionId,
    title: "Harness Thread",
    modelProvider: "openai",
    model: "gpt-5.2",
    cwd: "/tmp/workspace",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    status: { type: "loaded" },
  };
}

function threadSnapshot(sessionId: string) {
  return {
    sessionId,
    title: "Harness Snapshot Thread",
    titleSource: "model",
    titleModel: "gpt-5.2",
    provider: "openai",
    model: "gpt-5.2",
    sessionKind: "root",
    parentSessionId: null,
    role: null,
    mode: null,
    depth: 0,
    nickname: null,
    requestedModel: "gpt-5.2",
    effectiveModel: "gpt-5.2",
    requestedReasoningEffort: null,
    effectiveReasoningEffort: null,
    executionState: null,
    lastMessagePreview: "Hello from harness snapshot",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    messageCount: 2,
    lastEventSeq: 4,
    feed: [
      {
        id: "assistant-1",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Hello from harness snapshot",
      },
    ],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

function setDefaultJsonRpcHandlers(sessionId = "session-1") {
  jsonRpcHandlers.set("thread/list", async () => ({
    threads: [threadMeta(sessionId)],
  }));
  jsonRpcHandlers.set("thread/resume", async () => ({
    thread: threadMeta(sessionId),
  }));
  jsonRpcHandlers.set("thread/start", async () => ({
    thread: threadMeta(sessionId),
  }));
  jsonRpcHandlers.set("thread/read", async () => ({
    coworkSnapshot: threadSnapshot(sessionId),
  }));
  jsonRpcHandlers.set("cowork/provider/catalog/read", async () => ({
    event: {
      type: "provider_catalog",
      sessionId: "jsonrpc-control",
      all: [],
      default: {},
      connected: [],
    },
  }));
  jsonRpcHandlers.set("cowork/provider/authMethods/read", async () => ({
    event: {
      type: "provider_auth_methods",
      sessionId: "jsonrpc-control",
      methods: {},
    },
  }));
  jsonRpcHandlers.set("cowork/provider/status/refresh", async () => ({
    event: {
      type: "provider_status",
      sessionId: "jsonrpc-control",
      providers: [],
    },
  }));
  jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({
    event: {
      type: "mcp_servers",
      sessionId: "jsonrpc-control",
      servers: [],
      legacy: {
        workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: false },
        user: { path: "/home/test/.agent/mcp-servers.json", exists: false },
      },
      files: [],
    },
  }));
  jsonRpcHandlers.set("cowork/memory/list", async () => ({
    event: {
      type: "memory_list",
      sessionId: "jsonrpc-control",
      memories: [],
    },
  }));
  jsonRpcHandlers.set("cowork/skills/catalog/read", async () => ({
    event: {
      type: "skills_catalog",
      sessionId: "jsonrpc-control",
      catalog: { installations: [], sources: [], stats: { totalInstallations: 0, enabledInstallations: 0 } },
      mutationBlocked: false,
    },
  }));
  jsonRpcHandlers.set("cowork/skills/list", async () => ({
    event: {
      type: "skills_list",
      sessionId: "jsonrpc-control",
      skills: [],
    },
  }));
  jsonRpcHandlers.set("cowork/session/defaults/apply", async () => ({
    event: {
      type: "session_config",
      sessionId,
      config: {
        yolo: false,
        observabilityEnabled: false,
        backupsEnabled: true,
        defaultBackupsEnabled: true,
        enableMemory: true,
        memoryRequireApproval: false,
        preferredChildModel: "gpt-5.2",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5.2",
        allowedChildModelRefs: [],
        maxSteps: 100,
        toolOutputOverflowChars: 25000,
      },
    },
  }));
}

function seedStore(threadPatch: Record<string, unknown> = {}, runtimePatch: Record<string, unknown> = {}) {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const threadId = `thread-${crypto.randomUUID()}`;
  useAppStore.setState({
    ready: true,
    startupError: null,
    view: "chat",
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        path: "/tmp/workspace",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastOpenedAt: "2024-01-01T00:00:00.000Z",
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    threads: [
      {
        id: threadId,
        workspaceId,
        title: "Thread",
        titleSource: "manual",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastMessageAt: "2024-01-01T00:00:02.000Z",
        status: "disconnected",
        sessionId: "session-1",
        messageCount: 2,
        lastEventSeq: 4,
        draft: false,
        legacyTranscriptId: null,
        ...threadPatch,
      },
    ],
    selectedWorkspaceId: workspaceId,
    selectedThreadId: null,
    workspaceRuntimeById: {
      [workspaceId]: {
        serverUrl: "ws://mock",
        starting: false,
        error: null,
        controlSessionId: null,
        controlConfig: null,
        controlSessionConfig: null,
        controlEnableMcp: null,
        memories: [],
        memoriesLoading: false,
        mcpServers: [],
        mcpLegacy: null,
        mcpFiles: [],
        mcpWarnings: [],
        mcpValidationByName: {},
        mcpLastAuthChallenge: null,
        mcpLastAuthResult: null,
        skills: [],
        skillsCatalog: null,
        skillCatalogLoading: false,
        skillCatalogError: null,
        skillsMutationBlocked: false,
        skillsMutationBlockedReason: null,
        skillMutationPendingKeys: {},
        skillMutationError: null,
        selectedSkillName: null,
        selectedSkillContent: null,
        selectedSkillInstallationId: null,
        selectedSkillInstallation: null,
        selectedSkillPreview: null,
        skillUpdateChecksByInstallationId: {},
        workspaceBackupsPath: null,
        workspaceBackups: [],
        workspaceBackupsLoading: false,
        workspaceBackupsError: null,
        workspaceBackupPendingActionKeys: {},
        workspaceBackupDelta: null,
        workspaceBackupDeltaLoading: false,
        workspaceBackupDeltaError: null,
      },
    },
    threadRuntimeById: {
      [threadId]: {
        ...defaultThreadRuntime(),
        sessionId: "session-1",
        wsUrl: "ws://mock",
        ...runtimePatch,
      },
    },
    latestTodosByThreadId: {},
    workspaceExplorerById: {},
    promptModal: null,
    notifications: [],
    providerStatusByName: {},
    providerStatusLastUpdatedAt: null,
    providerStatusRefreshing: false,
    providerCatalog: [],
    providerDefaultModelByProvider: {},
    providerConnected: [],
    providerAuthMethodsByProvider: {},
    providerLastAuthChallenge: null,
    providerLastAuthResult: null,
    composerText: "",
    injectContext: false,
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
  } as any);
  return { workspaceId, threadId };
}

describe("thread reconnect over shared JSON-RPC socket", () => {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    readTranscriptCalls.length = 0;
    deleteTranscriptCalls.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.modelStreamByThread.clear();
    setDefaultJsonRpcHandlers();
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
  });

  test("reconnectThread resumes through the workspace JsonRpcSocket", async () => {
    const { threadId, workspaceId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();
    const activeThreadId = canonicalThreadId("session-1", threadId);

    expect(RUNTIME.jsonRpcSockets.has(workspaceId)).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.connected).toBe(true);
    expect(useAppStore.getState().threads.find((thread) => thread.id === activeThreadId)?.status).toBe("active");
  });

  test("reconnectThread dedupes an in-flight connect after draft thread identity migration", async () => {
    const draftThreadId = "draft-thread-1";
    seedStore({
      id: draftThreadId,
      sessionId: null,
      draft: true,
    }, {
      sessionId: null,
    });

    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    jsonRpcHandlers.set("thread/start", async () => ({
      thread: threadMeta("session-2"),
    }));
    jsonRpcHandlers.set("thread/read", async () => {
      await readBlocked;
      return {
        coworkSnapshot: threadSnapshot("session-2"),
      };
    });

    await useAppStore.getState().reconnectThread(draftThreadId, "hello once");
    await flushAsyncWork();

    const migratedThreadId = canonicalThreadId("session-2", draftThreadId);
    expect(migratedThreadId).toBe("session-2");
    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);

    await useAppStore.getState().reconnectThread(migratedThreadId);
    await flushAsyncWork();

    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/resume")).toHaveLength(0);

    releaseRead();
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[migratedThreadId]?.connected).toBe(true);
  });

  test("selectThread falls back to transcript hydration when thread/read has no snapshot", async () => {
    jsonRpcHandlers.set("thread/read", async () => ({ coworkSnapshot: null }));
    const { threadId } = seedStore({
      legacyTranscriptId: "legacy-thread-1",
    });

    await useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.transcriptOnly).toBe(true);
    expect(runtime?.feed[0]?.kind).toBe("message");
    expect(runtime?.feed[0]?.role).toBe("assistant");
    expect(readTranscriptCalls).toEqual(["legacy-thread-1", "session-1", threadId]);
    expect(jsonRpcRequests.map((entry) => entry.method)).not.toContain("thread/resume");
  });

  test("selectThread uses harness snapshot when available and does not read transcript cache", async () => {
    const { threadId } = seedStore();

    await useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.transcriptOnly).toBe(false);
    expect(runtime?.feed[0]?.text).toBe("Hello from harness snapshot");
    expect(readTranscriptCalls).toEqual([]);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
  });

  test("closing and reopening the shared JsonRpcSocket disconnects and auto-resumes tracked threads", async () => {
    const { threadId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();

    socket.close();
    await flushAsyncWork();
    const disconnectedThreadId = canonicalThreadId("session-1", threadId);
    expect(useAppStore.getState().threadRuntimeById[disconnectedThreadId]?.connected).toBe(false);
    expect(useAppStore.getState().threads.find((thread) => thread.id === disconnectedThreadId)?.status).toBe("disconnected");

    socket.reopen();
    await flushAsyncWork();

    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/resume")).toHaveLength(2);
    const resumedThreadId = canonicalThreadId("session-1", threadId);
    expect(useAppStore.getState().threadRuntimeById[resumedThreadId]?.connected).toBe(true);
    expect(useAppStore.getState().threads.find((thread) => thread.id === resumedThreadId)?.status).toBe("active");
  });
});
