import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const DESKTOP_STATE_CACHE_KEY = "cowork.desktop.state-cache.v2";
const storage = new Map<string, string>();

const localStorageMock = {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function installWindowMock() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: localStorageMock },
  });
}

function restoreWindowMock() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>).window;
}

installWindowMock();

const cachedState = {
  version: 1,
  persistedState: {
    version: 2,
    workspaces: [
      {
        id: "ws-cached",
        name: "Cached Workspace",
        path: "/tmp/workspace-cached",
        createdAt: "2026-03-19T00:00:00.000Z",
        lastOpenedAt: "2026-03-19T00:00:00.000Z",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    threads: [
      {
        id: "thread-cached",
        workspaceId: "ws-cached",
        title: "Cached Thread",
        titleSource: "manual",
        createdAt: "2026-03-19T00:00:00.000Z",
        lastMessageAt: "2026-03-19T00:00:00.000Z",
        status: "active",
        sessionId: null,
        messageCount: 0,
        lastEventSeq: 0,
      },
    ],
    developerMode: true,
    showHiddenFiles: true,
    perWorkspaceSettings: true,
  },
  ui: {
    selectedWorkspaceId: "ws-cached",
    selectedThreadId: "thread-cached",
    view: "skills",
    settingsPage: "workspaces",
    lastNonSettingsView: "skills",
    sidebarCollapsed: true,
    sidebarWidth: 320,
    contextSidebarCollapsed: true,
    contextSidebarWidth: 420,
    messageBarHeight: 180,
  },
};

const legacyCachedState = {
  version: 2,
  workspaces: [
    {
      id: "ws-cached",
      name: "Cached Workspace",
      path: "/tmp/workspace-cached",
      createdAt: "2026-03-19T00:00:00.000Z",
      lastOpenedAt: "2026-03-19T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: true,
      yolo: false,
    },
  ],
  threads: [
    {
      id: "thread-cached",
      workspaceId: "ws-cached",
      title: "Cached Thread",
      titleSource: "manual",
      createdAt: "2026-03-19T00:00:00.000Z",
      lastMessageAt: "2026-03-19T00:00:00.000Z",
      status: "active",
      sessionId: null,
      messageCount: 0,
      lastEventSeq: 0,
    },
  ],
  developerMode: true,
  showHiddenFiles: true,
  perWorkspaceSettings: true,
  ui: {
    selectedWorkspaceId: "ws-cached",
    selectedThreadId: "thread-cached",
    view: "skills",
    settingsPage: "workspaces",
    lastNonSettingsView: "skills",
    sidebarCollapsed: true,
    sidebarWidth: 320,
    contextSidebarCollapsed: true,
    contextSidebarWidth: 420,
    messageBarHeight: 180,
  },
};

function makeCachedSessionSnapshot(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    title: "Cached Harness Snapshot",
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
    lastMessagePreview: "Cached Harness Snapshot",
    createdAt: "2026-03-19T00:00:00.000Z",
    updatedAt: "2026-03-19T00:00:00.000Z",
    messageCount: 1,
    lastEventSeq: 2,
    feed: [],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
    ...overrides,
  };
}

let loadedState: any = {
  workspaces: [
    {
      id: "ws-live",
      name: "Live Workspace",
      path: "/tmp/workspace-live",
      createdAt: "2026-03-20T00:00:00.000Z",
      lastOpenedAt: "2026-03-20T00:00:00.000Z",
      defaultEnableMcp: true,
      defaultBackupsEnabled: true,
      yolo: false,
    },
  ],
  threads: [
    {
      id: "thread-live",
      workspaceId: "ws-live",
      title: "Live Thread",
      titleSource: "manual",
      createdAt: "2026-03-20T00:00:00.000Z",
      lastMessageAt: "2026-03-20T00:00:00.000Z",
      status: "active",
      sessionId: null,
      messageCount: 0,
      lastEventSeq: 0,
    },
  ],
  version: 2,
  developerMode: true,
  showHiddenFiles: true,
  perWorkspaceSettings: true,
};
let loadStateError: Error | null = null;

const MOCK_SYSTEM_APPEARANCE = {
  platform: "linux",
  themeSource: "system",
  shouldUseDarkColors: false,
  shouldUseDarkColorsForSystemIntegratedUI: false,
  shouldUseHighContrastColors: false,
  shouldUseInvertedColorScheme: false,
  prefersReducedTransparency: false,
  inForcedColorsMode: false,
};
const MOCK_UPDATE_STATE = {
  phase: "idle",
  currentVersion: "0.1.0",
  packaged: false,
  lastCheckStartedAt: null,
  lastCheckedAt: null,
  downloadedAt: null,
  message: null,
  release: null,
  progress: null,
  error: null,
};

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => {
    if (loadStateError) {
      throw loadStateError;
    }
    return loadedState;
  },
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
  JsonRpcSocket: class {
    readonly readyPromise = Promise.resolve();

    connect() {}
    async request(method: string) {
      if (method === "thread/list") {
        return { threads: [] };
      }
      if (method === "thread/start") {
        return {
          thread: {
            id: "thread-live",
            title: "Live Thread",
            modelProvider: "google",
            model: "gemini-3.1-pro-preview",
            cwd: "/tmp/workspace-live",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
            status: { type: "loaded" },
          },
        };
      }
      return {};
    }
    respond() {
      return true;
    }
    close() {}
  },
}));

localStorageMock.setItem(DESKTOP_STATE_CACHE_KEY, JSON.stringify(cachedState));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME } = await import("../src/app/store.helpers");
const { buildCachedDesktopStateSeed } = await import("../src/app/store.actions/bootstrap");
const { createDefaultUpdaterState } = await import("../src/lib/desktopApi");

function resetStoreToCachedSeed(value: unknown = cachedState) {
  const cachedSeed = buildCachedDesktopStateSeed(value);
  if (!cachedSeed) {
    throw new Error("Expected cached desktop seed");
  }
  useAppStore.setState({
    ready: false,
    bootstrapPending: false,
    startupError: null,
    view: "chat",
    settingsPage: "providers",
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
    providerUiState: { lmstudio: { enabled: false, hiddenModels: [] } },
    composerText: "",
    injectContext: false,
    developerMode: false,
    showHiddenFiles: false,
    perWorkspaceSettings: false,
    updateState: createDefaultUpdaterState("0.1.0", false),
    onboardingVisible: false,
    onboardingStep: "welcome",
    onboardingState: { status: "pending", completedAt: null, dismissedAt: null },
    sidebarCollapsed: false,
    sidebarWidth: 248,
    contextSidebarCollapsed: false,
    contextSidebarWidth: 300,
    messageBarHeight: 120,
    ...cachedSeed,
  });
}

describe("desktop bootstrap cache", () => {
  beforeEach(() => {
    installWindowMock();
    loadStateError = null;
    RUNTIME.sessionSnapshots.clear();
    loadedState = {
      ...loadedState,
      workspaces: [
        {
          id: "ws-live",
          name: "Live Workspace",
          path: "/tmp/workspace-live",
          createdAt: "2026-03-20T00:00:00.000Z",
          lastOpenedAt: "2026-03-20T00:00:00.000Z",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-live",
          workspaceId: "ws-live",
          title: "Live Thread",
          titleSource: "manual",
          createdAt: "2026-03-20T00:00:00.000Z",
          lastMessageAt: "2026-03-20T00:00:00.000Z",
          status: "active",
          sessionId: null,
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
    };
    localStorageMock.clear();
    localStorageMock.setItem(DESKTOP_STATE_CACHE_KEY, JSON.stringify(cachedState));
    resetStoreToCachedSeed();
  });

  afterAll(() => {
    restoreWindowMock();
  });

  test("buildCachedDesktopStateSeed restores shell state from cache", () => {
    const seed = buildCachedDesktopStateSeed(cachedState);
    expect(seed?.ready).toBe(true);
    expect(seed?.bootstrapPending).toBe(true);
    expect(seed?.selectedWorkspaceId).toBe("ws-cached");
    expect(seed?.selectedThreadId).toBe("thread-cached");
    expect(seed?.view).toBe("skills");
    expect(seed?.sidebarCollapsed).toBe(true);
    expect(seed?.sidebarWidth).toBe(320);
    expect(seed?.contextSidebarCollapsed).toBe(true);
    expect(seed?.contextSidebarWidth).toBe(420);
    expect(seed?.messageBarHeight).toBe(180);
    expect(seed?.threadRuntimeById?.["thread-cached"]?.hydrating).toBeUndefined();
  });

  test("buildCachedDesktopStateSeed accepts legacy cached payloads", () => {
    const seed = buildCachedDesktopStateSeed(legacyCachedState);
    expect(seed?.selectedWorkspaceId).toBe("ws-cached");
    expect(seed?.selectedThreadId).toBe("thread-cached");
    expect(seed?.view).toBe("skills");
    expect(seed?.workspaces?.[0]?.wsProtocol).toBe("jsonrpc");
  });

  test("buildCachedDesktopStateSeed marks a cached chat thread as hydrating", () => {
    const chatCachedState = {
      ...cachedState,
      ui: {
        ...cachedState.ui,
        view: "chat",
      },
    };
    const seed = buildCachedDesktopStateSeed(chatCachedState);
    expect(seed?.threadRuntimeById?.["thread-cached"]?.hydrating).toBe(true);
  });

  test("buildCachedDesktopStateSeed restores cached harness snapshots for warm startup", () => {
    const snapshotCachedState = {
      ...cachedState,
      sessionSnapshots: {
        "thread-session": {
          fingerprint: {
            updatedAt: "2026-03-19T00:00:00.000Z",
            messageCount: 1,
            lastEventSeq: 2,
          },
          snapshot: {
            sessionId: "thread-session",
            title: "Cached Harness Snapshot",
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
            lastMessagePreview: "Cached Harness Snapshot",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
            messageCount: 1,
            lastEventSeq: 2,
            feed: [],
            agents: [],
            todos: [],
            sessionUsage: null,
            lastTurnUsage: null,
            hasPendingAsk: false,
            hasPendingApproval: false,
          },
        },
      },
    };

    const seed = buildCachedDesktopStateSeed(snapshotCachedState);
    expect(seed?.ready).toBe(true);
    expect(RUNTIME.sessionSnapshots.get("thread-session")?.snapshot.title).toBe("Cached Harness Snapshot");
  });

  test("buildCachedDesktopStateSeed rebuilds valid snapshot fingerprints and ignores malformed entries", () => {
    RUNTIME.sessionSnapshots.set("stale-session", {
      fingerprint: { updatedAt: "2026-03-18T00:00:00.000Z", messageCount: 0, lastEventSeq: 0 },
      snapshot: makeCachedSessionSnapshot("stale-session"),
    });
    const validSnapshot = makeCachedSessionSnapshot("thread-session", { title: "Recovered Cached Snapshot" });
    const snapshotCachedState = {
      ...cachedState,
      sessionSnapshots: {
        "thread-session": {
          snapshot: validSnapshot,
        },
        "broken-session": {
          snapshot: {
            sessionId: "broken-session",
          },
        },
        "mismatched-session": {
          snapshot: makeCachedSessionSnapshot("different-session"),
        },
      },
    };

    const seed = buildCachedDesktopStateSeed(snapshotCachedState);

    expect(seed?.ready).toBe(true);
    expect(RUNTIME.sessionSnapshots.size).toBe(1);
    expect(RUNTIME.sessionSnapshots.get("thread-session")).toEqual({
      fingerprint: {
        updatedAt: validSnapshot.updatedAt,
        messageCount: validSnapshot.messageCount,
        lastEventSeq: validSnapshot.lastEventSeq,
      },
      snapshot: validSnapshot,
    });
    expect(RUNTIME.sessionSnapshots.has("broken-session")).toBe(false);
    expect(RUNTIME.sessionSnapshots.has("mismatched-session")).toBe(false);
    expect(RUNTIME.sessionSnapshots.has("stale-session")).toBe(false);
  });

  test("init keeps cached state visible until authoritative load completes", async () => {
    const initPromise = useAppStore.getState().init();
    expect(useAppStore.getState().ready).toBe(true);
    expect(useAppStore.getState().bootstrapPending).toBe(true);

    await initPromise;

    const state = useAppStore.getState();
    expect(state.bootstrapPending).toBe(false);
    expect(state.selectedWorkspaceId).toBe("ws-live");
    expect(state.selectedThreadId).toBe("thread-live");
    expect(state.view).toBe("skills");
    expect(state.sidebarCollapsed).toBe(true);
  });

  test("init marks the selected startup thread as hydrating before deferred restore finishes", async () => {
    const chatCachedState = {
      ...cachedState,
      ui: {
        ...cachedState.ui,
        view: "chat",
        selectedWorkspaceId: "ws-live",
        selectedThreadId: "thread-live",
      },
    };
    localStorageMock.setItem(DESKTOP_STATE_CACHE_KEY, JSON.stringify(chatCachedState));
    resetStoreToCachedSeed(chatCachedState);

    await useAppStore.getState().init();

    expect(useAppStore.getState().threadRuntimeById["thread-live"]?.hydrating).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();

    expect(useAppStore.getState().threadRuntimeById["thread-live"]?.hydrating).toBe(false);
  });

  test("init preserves cached state when authoritative load fails", async () => {
    loadStateError = new Error("state load exploded");

    await useAppStore.getState().init();

    const state = useAppStore.getState();
    expect(state.bootstrapPending).toBe(false);
    expect(state.startupError).toContain("state load exploded");
    expect(state.workspaces[0]?.id).toBe("ws-cached");
    expect(state.selectedThreadId).toBe("thread-cached");
  });
});
