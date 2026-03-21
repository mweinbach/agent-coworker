import { beforeEach, describe, expect, mock, test } from "bun:test";

const startCalls: Array<{ workspaceId: string; workspacePath: string; yolo: boolean }> = [];
const savedStates: any[] = [];
const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];

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

class MockAgentSocket {
  connect() {}
  send() {
    return true;
  }
  close() {}
}

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();

  constructor(public readonly opts: { onOpen?: () => void }) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    if (method === "thread/list") {
      return {
        threads: [],
      };
    }
    if (method === "thread/start") {
      return {
        thread: {
          id: "jsonrpc-thread-1",
          title: "New session",
          modelProvider: "google",
          model: "gemini-3.1-pro-preview",
          cwd: "/tmp/jsonrpc-workspace",
          createdAt: "2026-03-21T00:00:00.000Z",
          updatedAt: "2026-03-21T00:00:00.000Z",
          status: { type: "loaded" },
        },
      };
    }
    if (method === "turn/start") {
      return {
        turn: {
          id: "turn-1",
          threadId: "jsonrpc-thread-1",
          status: "inProgress",
          items: [],
        },
      };
    }
    if (method === "thread/read") {
      return {
        coworkSnapshot: {
          sessionId: "jsonrpc-thread-1",
          title: "New session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3.1-pro-preview",
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
          createdAt: "2026-03-21T00:00:00.000Z",
          updatedAt: "2026-03-21T00:00:00.000Z",
          messageCount: 0,
          lastEventSeq: 0,
          feed: [],
          agents: [],
          todos: [],
          sessionUsage: null,
          lastTurnUsage: null,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      };
    }
    return {};
  }

  respond() {
    return true;
  }

  close() {}
}

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async (state: any) => {
    savedStates.push(state);
  },
  startWorkspaceServer: async (opts: { workspaceId: string; workspacePath: string; yolo: boolean }) => {
    startCalls.push(opts);
    return { url: "ws://jsonrpc-workspace" };
  },
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
  AgentSocket: MockAgentSocket,
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME } = await import("../src/app/store.helpers");

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("desktop JSON-RPC single connection path", () => {
  beforeEach(() => {
    startCalls.length = 0;
    savedStates.length = 0;
    jsonRpcRequests.length = 0;
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.threadSockets.clear();
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.modelStreamByThread.clear();
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      workspaces: [
        {
          id: "ws-jsonrpc",
          name: "JSON-RPC Workspace",
          path: "/tmp/jsonrpc-workspace",
          createdAt: "2026-03-21T00:00:00.000Z",
          lastOpenedAt: "2026-03-21T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      selectedWorkspaceId: null,
      selectedThreadId: null,
      workspaceRuntimeById: {},
      threadRuntimeById: {},
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
  });

  test("uses one workspace JsonRpcSocket for thread start and turn start", async () => {
    await useAppStore.getState().selectWorkspace("ws-jsonrpc");
    await useAppStore.getState().newThread({
      workspaceId: "ws-jsonrpc",
      titleHint: "Draft",
      firstMessage: "hello over jsonrpc",
    });
    await flushAsyncWork();

    expect(RUNTIME.controlSockets.has("ws-jsonrpc")).toBe(false);
    expect(RUNTIME.jsonRpcSockets.has("ws-jsonrpc")).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(RUNTIME.threadSockets.size).toBe(0);
    expect(jsonRpcRequests.map((entry) => entry.method)).toEqual([
      "thread/list",
      "thread/start",
      "turn/start",
    ]);

    const state = useAppStore.getState();
    expect(state.threads[0]?.id).toBe("jsonrpc-thread-1");
    expect(state.threadRuntimeById["jsonrpc-thread-1"]?.sessionId).toBe("jsonrpc-thread-1");
    expect(state.threadRuntimeById["jsonrpc-thread-1"]?.connected).toBe(true);
  });
});
