import { beforeEach, describe, expect, mock, test } from "bun:test";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: unknown) => unknown | Promise<unknown>>();

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

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();
  readonly responses: Array<{ id: string | number; result: unknown }> = [];

  constructor(
    public readonly opts: {
      onOpen?: () => void;
      onClose?: () => void;
      onNotification?: (message: any) => void;
      onServerRequest?: (message: any) => void;
    },
  ) {
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

  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
    return true;
  }

  close() {
    this.opts.onClose?.();
  }

  notify(method: string, params?: unknown) {
    this.opts.onNotification?.({ method, params });
  }

  requestFromServer(id: string | number, method: string, params?: unknown) {
    this.opts.onServerRequest?.({ id, method, params });
  }
}

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
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

function threadMeta(sessionId = "thread-session") {
  return {
    id: sessionId,
    title: "Recovered thread",
    modelProvider: "openai",
    model: "gpt-5.2",
    cwd: "/tmp/workspace",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    status: { type: "loaded" },
  };
}

function threadSnapshot(sessionId = "thread-session") {
  return {
    sessionId,
    title: "Recovered thread",
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
    lastMessagePreview: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

function setDefaultHandlers(sessionId = "thread-session") {
  jsonRpcHandlers.set("thread/list", async () => ({
    threads: [threadMeta(sessionId)],
  }));
  jsonRpcHandlers.set("thread/read", async () => ({
    coworkSnapshot: threadSnapshot(sessionId),
  }));
  jsonRpcHandlers.set("thread/resume", async () => ({
    thread: threadMeta(sessionId),
  }));
  jsonRpcHandlers.set("cowork/provider/catalog/read", async () => ({
    event: { type: "provider_catalog", sessionId: "jsonrpc-control", all: [], default: {}, connected: [] },
  }));
  jsonRpcHandlers.set("cowork/provider/authMethods/read", async () => ({
    event: { type: "provider_auth_methods", sessionId: "jsonrpc-control", methods: {} },
  }));
  jsonRpcHandlers.set("cowork/provider/status/refresh", async () => ({
    event: { type: "provider_status", sessionId: "jsonrpc-control", providers: [] },
  }));
  jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({
    event: {
      type: "mcp_servers",
      sessionId: "jsonrpc-control",
      servers: [],
      legacy: {
        workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: false },
        user: { path: "/tmp/home/.agent/mcp-servers.json", exists: false },
      },
      files: [],
    },
  }));
  jsonRpcHandlers.set("cowork/memory/list", async () => ({
    event: { type: "memory_list", sessionId: "jsonrpc-control", memories: [] },
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
    event: { type: "skills_list", sessionId: "jsonrpc-control", skills: [] },
  }));
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("desktop JSON-RPC event mapping", () => {
  let workspaceId = "";
  let threadId = "";
  let sessionId = "";

  beforeEach(() => {
    workspaceId = `ws-${crypto.randomUUID()}`;
    threadId = `thread-${crypto.randomUUID()}`;
    sessionId = `session-${crypto.randomUUID()}`;

    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadSteers.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.modelStreamByThread.clear();
    setDefaultHandlers(sessionId);

    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      workspaces: [
        {
          id: workspaceId,
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastOpenedAt: "2024-01-01T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: workspaceId,
      selectedThreadId: threadId,
      threads: [
        {
          id: threadId,
          workspaceId,
          title: "Recovered thread",
          titleSource: "manual",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:02.000Z",
          status: "disconnected",
          sessionId,
          messageCount: 0,
          lastEventSeq: 0,
          draft: false,
          legacyTranscriptId: null,
        },
      ],
      workspaceRuntimeById: {
        [workspaceId]: {
          serverUrl: "ws://mock",
          starting: false,
          error: null,
          controlSessionId: null,
          controlConfig: null,
          controlSessionConfig: null,
          controlEnableMcp: null,
          mcpServers: [],
          mcpLegacy: null,
          mcpFiles: [],
          mcpWarnings: [],
          mcpValidationByName: {},
          mcpLastAuthChallenge: null,
          mcpLastAuthResult: null,
          skills: [],
          skillsCatalog: null,
          selectedSkillName: null,
          selectedSkillContent: null,
          selectedSkillInstallationId: null,
          selectedSkillInstallation: null,
          selectedSkillPreview: null,
          skillUpdateChecksByInstallationId: {},
          skillCatalogLoading: false,
          skillCatalogError: null,
          skillsMutationBlocked: false,
          skillsMutationBlockedReason: null,
          skillMutationPendingKeys: {},
          skillMutationError: null,
          memories: [],
          memoriesLoading: false,
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
          wsUrl: "ws://mock",
          sessionId,
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
    } as any);
  });

  test("shared JSON-RPC notifications stream assistant output and clear busy state", async () => {
    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "assistant-1",
      delta: "Hello from JSON-RPC",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { type: "agentMessage", text: "Hello from JSON-RPC" },
    });
    socket.notify("turn/completed", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "completed" },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    expect(runtime?.busy).toBe(false);
    expect(runtime?.activeTurnId).toBeNull();
    expect(runtime?.feed.some((item) => "text" in item && typeof item.text === "string" && item.text.includes("Hello from JSON-RPC"))).toBe(true);
  });

  test("shared JSON-RPC notifications hydrate live session metadata immediately", async () => {
    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();

    socket.notify("cowork/session/info", {
      type: "session_info",
      sessionId,
      title: "Renamed over JSON-RPC",
      titleSource: "manual",
      titleModel: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:03.000Z",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    socket.notify("cowork/session/configUpdated", {
      type: "config_updated",
      sessionId,
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
        workingDirectory: "/tmp/workspace",
      },
    });
    socket.notify("cowork/session/settings", {
      type: "session_settings",
      sessionId,
      enableMcp: false,
      enableMemory: true,
      memoryRequireApproval: false,
    });
    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
      config: {
        yolo: false,
        observabilityEnabled: false,
        backupsEnabled: true,
        defaultBackupsEnabled: true,
        enableMemory: true,
        memoryRequireApproval: false,
        preferredChildModel: "gpt-5.4-mini",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5.4-mini",
        allowedChildModelRefs: [],
        maxSteps: 100,
        toolOutputOverflowChars: 25000,
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.title).toBe("Renamed over JSON-RPC");
    expect(runtime?.config?.model).toBe("gpt-5.4-mini");
    expect(runtime?.enableMcp).toBe(false);
    expect(runtime?.sessionConfig?.preferredChildModel).toBe("gpt-5.4-mini");
  });

  test("server ask requests open a prompt and answerAsk responds on the shared socket", async () => {
    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    socket.requestFromServer("ask-1", "item/tool/requestUserInput", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-1",
      question: "Continue?",
      options: ["Yes", "No"],
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(useAppStore.getState().promptModal).toMatchObject({
      kind: "ask",
      threadId,
      prompt: {
        requestId: "ask-1",
        question: "Continue?",
        options: ["Yes", "No"],
      },
    });

    useAppStore.getState().answerAsk(threadId, "ask-1", "Yes");

    expect(socket.responses).toEqual([{ id: "ask-1", result: { answer: "Yes" } }]);
    expect(useAppStore.getState().promptModal).toBeNull();
  });

  test("server approval requests open a prompt and answerApproval responds on the shared socket", async () => {
    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    socket.requestFromServer("approval-1", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-2",
      command: "rm -rf build",
      dangerous: true,
      reason: "requires_manual_review",
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(useAppStore.getState().promptModal).toMatchObject({
      kind: "approval",
      threadId,
      prompt: {
        requestId: "approval-1",
        command: "rm -rf build",
        dangerous: true,
        reasonCode: "requires_manual_review",
      },
    });

    useAppStore.getState().answerApproval(threadId, "approval-1", true);

    expect(socket.responses).toEqual([{ id: "approval-1", result: { decision: "accept" } }]);
    expect(useAppStore.getState().promptModal).toBeNull();
  });
});
