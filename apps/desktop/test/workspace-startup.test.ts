import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const startDeferreds: Deferred<{ url: string }>[] = [];
const startCalls: Array<{ workspaceId: string; workspacePath: string; yolo: boolean }> = [];
const stopCalls: string[] = [];
const savedStates: any[] = [];
let pickedWorkspaceDirectory: string | null = null;

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
  static autoOpen = true;

  readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void }) {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  connect() {
    if (!MockJsonRpcSocket.autoOpen) {
      return;
    }
    this.resolveReady();
    this.opts.onOpen?.();
  }

  async request(method: string) {
    if (method === "thread/list") {
      return { threads: [] };
    }
    return {};
  }

  respond() {
    return true;
  }

  close() {
    this.opts.onClose?.();
  }
}

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => pickedWorkspaceDirectory,
  readTranscript: async () => [],
  saveState: async (state: any) => {
    savedStates.push(state);
  },
  startWorkspaceServer: async (opts: { workspaceId: string; workspacePath: string; yolo: boolean }) => {
    startCalls.push(opts);
    const deferred = createDeferred<{ url: string }>();
    startDeferreds.push(deferred);
    return await deferred.promise;
  },
  stopWorkspaceServer: async ({ workspaceId }: { workspaceId: string }) => {
    stopCalls.push(workspaceId);
  },
  showContextMenu: async () => null,
  windowMinimize: async () => {},
  windowMaximize: async () => {},
  windowClose: async () => {},
  getPlatform: async () => "linux",
  readFile: async () => "",
  previewOSFile: async () => {},
  openPath: async () => {},
  openExternalUrl: async () => {},
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
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME } = await import("../src/app/store.helpers");

const defaultProviderActions = {
  requestProviderCatalog: useAppStore.getState().requestProviderCatalog,
  requestProviderAuthMethods: useAppStore.getState().requestProviderAuthMethods,
  refreshProviderStatus: useAppStore.getState().refreshProviderStatus,
};

describe("workspace startup flow", () => {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    startDeferreds.length = 0;
    startCalls.length = 0;
    stopCalls.length = 0;
    savedStates.length = 0;
    pickedWorkspaceDirectory = null;
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.modelStreamByThread.clear();
    RUNTIME.jsonRpcSockets.clear();
    MockJsonRpcSocket.autoOpen = true;

    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "settings",
      settingsPage: "workspaces",
      lastNonSettingsView: "chat",
      workspaces: [],
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
      ...defaultProviderActions,
      composerText: "",
      injectContext: false,
      developerMode: false,
      showHiddenFiles: false,
      sidebarCollapsed: false,
      contextSidebarCollapsed: false,
      contextSidebarWidth: 300,
      messageBarHeight: 120,
      sidebarWidth: 280,
    });
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
  });

  test("addWorkspace persists once before starting the new workspace server", async () => {
    pickedWorkspaceDirectory = "/tmp/new-workspace";

    const addPromise = useAppStore.getState().addWorkspace();
    await flushAsyncWork();

    expect(savedStates).toHaveLength(1);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.workspacePath).toBe("/tmp/new-workspace");

    startDeferreds[0]?.resolve({ url: "ws://new-workspace" });
    await addPromise;

    const state = useAppStore.getState();
    expect(state.workspaces).toHaveLength(1);
    expect(state.workspaces[0]?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(state.workspaceRuntimeById[state.workspaces[0]!.id]?.serverUrl).toBe("ws://new-workspace");
  });

  test("restartWorkspaceServer supersedes an in-flight startup and ignores stale completion", async () => {
    const workspaceId = "ws-restart";
    useAppStore.setState({
      workspaces: [
        {
          id: workspaceId,
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: "2026-03-08T00:00:00.000Z",
          lastOpenedAt: "2026-03-08T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: workspaceId,
    });

    const firstStart = useAppStore.getState().selectWorkspace(workspaceId);
    await flushAsyncWork();
    expect(startCalls).toHaveLength(1);

    const restart = useAppStore.getState().restartWorkspaceServer(workspaceId);
    await flushAsyncWork();

    expect(stopCalls).toEqual([workspaceId]);
    expect(startCalls).toHaveLength(2);

    startDeferreds[0]?.resolve({ url: "ws://stale" });
    await firstStart;

    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.serverUrl).toBeNull();

    startDeferreds[1]?.resolve({ url: "ws://fresh" });
    await restart;

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.serverUrl).toBe("ws://fresh");
    expect(runtime?.error).toBeNull();
  });

  test("selectWorkspace does not persist when the workspace is already selected", async () => {
    const workspaceId = "ws-existing";
    useAppStore.setState({
      workspaces: [
        {
          id: workspaceId,
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: "2026-03-08T00:00:00.000Z",
          lastOpenedAt: "2026-03-08T00:00:00.000Z",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: workspaceId,
    });

    const selectPromise = useAppStore.getState().selectWorkspace(workspaceId);
    await flushAsyncWork();

    expect(savedStates).toHaveLength(0);
    expect(startCalls).toHaveLength(1);

    startDeferreds[0]?.resolve({ url: "ws://existing" });
    await selectPromise;
  });

  test("provider auth method refresh stays quiet while the control socket is still handshaking", async () => {
    const workspaceId = "ws-provider";
    MockJsonRpcSocket.autoOpen = false;
    useAppStore.setState({
      workspaces: [
        {
          id: workspaceId,
          name: "Workspace",
          path: "/tmp/workspace",
          createdAt: "2026-03-17T00:00:00.000Z",
          lastOpenedAt: "2026-03-17T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      selectedWorkspaceId: workspaceId,
    });

    const refreshPromise = useAppStore.getState().requestProviderAuthMethods();
    await flushAsyncWork();

    expect(startCalls).toHaveLength(1);
    startDeferreds[0]?.resolve({ url: "ws://provider" });
    await refreshPromise;

    expect(useAppStore.getState().notifications).toEqual([]);
    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.controlSessionId).toBeNull();
    expect(useAppStore.getState().providerStatusRefreshing).toBeFalse();
    expect(RUNTIME.jsonRpcSockets.has(workspaceId)).toBeTrue();
  });
});
