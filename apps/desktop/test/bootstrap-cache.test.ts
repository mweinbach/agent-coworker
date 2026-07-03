import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { TaskRecord, TaskSummary } from "../../../src/shared/tasks";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

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
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installWindowMock(overrides: Record<string, unknown> = {}) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "" }, localStorage: localStorageMock, ...overrides },
  });
}

function restoreWindowMock() {
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
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
    taskType: null,
    targetPaths: null,
    profile: null,
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

const NOW = "2026-03-20T00:00:00.000Z";

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    workspacePath: "/tmp/workspace-live",
    title: "Cached task",
    objective: "Restore task state from the harness.",
    status: "working",
    revision: 2,
    reviewRequired: true,
    createdAt: NOW,
    updatedAt: NOW,
    threadCount: 1,
    completedWorkItemCount: 0,
    totalWorkItemCount: 1,
    activeBlockerCount: 0,
    pendingQuestionCount: 0,
    blockingQuestionCount: 0,
    requirements: [],
    threads: [
      {
        id: "task-thread-1",
        taskId: "task-1",
        sessionId: "task-session-1",
        title: "Main",
        createdBy: "coordinator",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    workItems: [
      {
        id: "work-1",
        taskId: "task-1",
        title: "Restore context",
        description: "",
        status: "in_progress",
        dependsOn: [],
        assignedThreadId: null,
        claimedByThreadId: null,
        expectedOutputs: [],
        completionEvidence: null,
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    decisions: [],
    questions: [],
    artifacts: [],
    blockers: [],
    activity: [],
    latestCheckpoint: null,
    ...overrides,
  };
}

function taskSummary(task: TaskRecord): TaskSummary {
  return {
    id: task.id,
    workspacePath: task.workspacePath,
    title: task.title,
    objective: task.objective,
    status: task.status,
    revision: task.revision,
    reviewRequired: task.reviewRequired,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    threadCount: task.threadCount,
    completedWorkItemCount: task.completedWorkItemCount,
    totalWorkItemCount: task.totalWorkItemCount,
    activeBlockerCount: task.activeBlockerCount,
    pendingQuestionCount: task.pendingQuestionCount,
    blockingQuestionCount: task.blockingQuestionCount,
    ...(task.context ? { context: task.context } : {}),
    ...(task.sourceSessionId !== undefined ? { sourceSessionId: task.sourceSessionId } : {}),
    ...(task.creationOrigin ? { creationOrigin: task.creationOrigin } : {}),
    ...(task.reviewRounds !== undefined ? { reviewRounds: task.reviewRounds } : {}),
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
let taskListResponse: TaskSummary[] = [];
let taskReadResponse: TaskRecord | null = null;
const socketRequests: string[] = [];
let remoteAccessEnabled = true;
let packagedApp = false;

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

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
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
    getDesktopFeatureFlags: (featureOverrides) => ({
      menuBar: typeof featureOverrides?.menuBar === "boolean" ? featureOverrides.menuBar : true,
      remoteAccess:
        typeof featureOverrides?.remoteAccess === "boolean"
          ? featureOverrides.remoteAccess
          : packagedApp
            ? false
            : remoteAccessEnabled,
      workspacePicker:
        typeof featureOverrides?.workspacePicker === "boolean"
          ? featureOverrides.workspacePicker
          : true,
      workspaceLifecycle:
        typeof featureOverrides?.workspaceLifecycle === "boolean"
          ? featureOverrides.workspaceLifecycle
          : true,
      openAiNativeConnectors:
        typeof featureOverrides?.openAiNativeConnectors === "boolean"
          ? featureOverrides.openAiNativeConnectors
          : false,
      canvas: typeof featureOverrides?.canvas === "boolean" ? featureOverrides.canvas : false,
      // Default the durable Tasks flag ON in this harness so existing task
      // hydration assertions keep exercising task view; OFF cases pass an
      // explicit `{ tasks: false }` override.
      tasks: typeof featureOverrides?.tasks === "boolean" ? featureOverrides.tasks : true,
    }),
    isPackagedDesktopApp: () => packagedApp,
    checkForUpdates: async () => {},
    quitAndInstallUpdate: async () => {},
    onSystemAppearanceChanged: () => () => {},
    onMenuCommand: () => () => {},
    onUpdateStateChanged: () => () => {},
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: class {
    readonly readyPromise = Promise.resolve();

    connect() {}
    async request(method: string) {
      socketRequests.push(method);
      if (method === "task/list") {
        return { tasks: taskListResponse };
      }
      if (method === "task/read") {
        return taskReadResponse ? { task: taskReadResponse } : {};
      }
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
const { RUNTIME, syncDesktopStateCacheNow } = await import("../src/app/store.helpers");
const { buildCachedDesktopStateSeed } = await import("../src/app/store.actions/bootstrap");
const { defaultThreadRuntime } = await import("../src/app/store.helpers/runtimeState");
const { createDefaultUpdaterState } = await import("../src/lib/desktopApi");

type AppStoreState = ReturnType<typeof useAppStore.getState>;
const defaultRefreshTasks = useAppStore.getState().refreshTasks;
const defaultSelectTask = useAppStore.getState().selectTask;

function restoreTaskHydrationActions() {
  useAppStore.setState({
    refreshTasks: defaultRefreshTasks,
    selectTask: defaultSelectTask,
  });
}

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
    selectedTaskId: null,
    newTaskWorkspaceId: null,
    newTaskWorkspaceRequestId: 0,
    taskSummariesByWorkspaceId: {},
    tasksById: {},
    taskListLoadingByWorkspaceId: {},
    taskError: null,
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

function installTaskHydrationStub() {
  useAppStore.setState({
    refreshTasks: async (workspaceId?: string) => {
      socketRequests.push("task/list");
      const targetWorkspaceId = workspaceId ?? useAppStore.getState().selectedWorkspaceId;
      if (!targetWorkspaceId) {
        return;
      }
      useAppStore.setState((state: AppStoreState) => ({
        taskSummariesByWorkspaceId: {
          ...state.taskSummariesByWorkspaceId,
          [targetWorkspaceId]: taskListResponse,
        },
      }));
    },
    selectTask: async (taskId: string, options?: { preserveView?: boolean }) => {
      socketRequests.push("task/read");
      const task = taskReadResponse;
      if (!task || task.id !== taskId) {
        return;
      }
      const workspaceId = useAppStore.getState().selectedWorkspaceId;
      const mainThread = task.threads[0] ?? null;
      useAppStore.setState((state: AppStoreState) => ({
        tasksById: { ...state.tasksById, [task.id]: task },
        threads: mainThread
          ? [
              ...state.threads.filter((thread) => thread.id !== mainThread.sessionId),
              {
                id: mainThread.sessionId,
                workspaceId,
                sessionId: mainThread.sessionId,
                title: mainThread.title,
                titleSource: "manual",
                createdAt: mainThread.createdAt,
                lastMessageAt: mainThread.updatedAt,
                status: "active",
                messageCount: 0,
                lastEventSeq: 0,
                taskId: task.id,
                taskThreadId: mainThread.id,
              },
            ]
          : state.threads,
        threadRuntimeById: mainThread
          ? { ...state.threadRuntimeById, [mainThread.sessionId]: defaultThreadRuntime() }
          : state.threadRuntimeById,
        selectedWorkspaceId: workspaceId,
        selectedTaskId: task.id,
        selectedThreadId: mainThread?.sessionId ?? null,
        newTaskWorkspaceId: null,
        ...(options?.preserveView ? {} : { view: "task" as const }),
        taskError: null,
      }));
    },
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("desktop bootstrap cache", () => {
  beforeEach(() => {
    restoreTaskHydrationActions();
    installWindowMock();
    loadStateError = null;
    taskListResponse = [];
    taskReadResponse = null;
    socketRequests.length = 0;
    remoteAccessEnabled = true;
    packagedApp = false;
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.jsonRpcSockets.clear();
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

  afterEach(() => {
    restoreTaskHydrationActions();
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
    expect(seed?.view).toBe("settings");
    expect(seed?.sidebarCollapsed).toBe(true);
    expect(seed?.sidebarWidth).toBe(320);
    expect(seed?.contextSidebarCollapsed).toBe(true);
    expect(seed?.contextSidebarWidth).toBe(420);
    expect(seed?.messageBarHeight).toBe(180);
    expect(seed?.privacyTelemetrySettings).toEqual({
      crashReportsEnabled: false,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: false,
      cloudSyncEnabled: false,
    });
    expect(seed?.threadRuntimeById?.["thread-cached"]?.hydrating).toBeUndefined();
  });

  test("buildCachedDesktopStateSeed preserves an explicitly selected task", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      ui: {
        ...cachedState.ui,
        view: "task",
        selectedThreadId: null,
        selectedTaskId: "task-1",
      },
    });

    expect(seed?.view).toBe("task");
    expect(seed?.selectedTaskId).toBe("task-1");
    expect(seed?.selectedThreadId).not.toBe("task-1");
  });

  test("buildCachedDesktopStateSeed normalizes task view to chat when the tasks flag is disabled", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        desktopFeatureFlagOverrides: { tasks: false },
      },
      ui: {
        ...cachedState.ui,
        view: "task",
        selectedThreadId: null,
        selectedTaskId: "task-1",
      },
    });

    expect(seed?.view).toBe("chat");
    expect(seed?.selectedTaskId).toBeNull();
  });

  test("buildCachedDesktopStateSeed clears a task lastNonSettingsView when the tasks flag is disabled", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        desktopFeatureFlagOverrides: { tasks: false },
      },
      ui: {
        ...cachedState.ui,
        view: "settings",
        settingsPage: "models",
        lastNonSettingsView: "task",
        selectedTaskId: "task-1",
      },
    });

    expect(seed?.lastNonSettingsView).toBe("chat");
    expect(seed?.selectedTaskId).toBeNull();
  });

  test("buildCachedDesktopStateSeed does not select chat fallback for task view without a selected task", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "chat-session-1",
            sessionId: "chat-session-1",
            title: "Ordinary chat",
            lastMessageAt: "2026-03-19T01:00:00.000Z",
          },
        ],
      },
      ui: {
        ...cachedState.ui,
        view: "task",
        selectedThreadId: null,
        selectedTaskId: null,
      },
    });

    expect(seed?.view).toBe("task");
    expect(seed?.selectedTaskId).toBeNull();
    expect(seed?.selectedThreadId).toBeNull();
  });

  test("buildCachedDesktopStateSeed preserves task thread ownership metadata", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "task-session-1",
            sessionId: "task-session-1",
            title: "Task thread",
            taskId: "task-1",
            taskThreadId: "task-thread-1",
          },
        ],
      },
    });

    expect(seed?.threads).toEqual([
      expect.objectContaining({
        id: "task-session-1",
        sessionId: "task-session-1",
        taskId: "task-1",
        taskThreadId: "task-thread-1",
      }),
    ]);
  });

  test("buildCachedDesktopStateSeed preserves task id when settings overlays task view without a persisted task thread", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "chat-session-1",
            sessionId: "chat-session-1",
            title: "Ordinary chat",
            lastMessageAt: "2026-03-19T01:00:00.000Z",
          },
        ],
      },
      ui: {
        ...cachedState.ui,
        view: "settings",
        lastNonSettingsView: "task",
        selectedThreadId: null,
        selectedTaskId: "task-1",
      },
    });

    expect(seed?.view).toBe("settings");
    expect(seed?.lastNonSettingsView).toBe("task");
    expect(seed?.selectedThreadId).toBeNull();
    expect(seed?.selectedTaskId).toBe("task-1");
  });

  test("buildCachedDesktopStateSeed does not select chat fallback for settings over task without a selected task", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "chat-session-1",
            sessionId: "chat-session-1",
            title: "Ordinary chat",
            lastMessageAt: "2026-03-19T01:00:00.000Z",
          },
        ],
      },
      ui: {
        ...cachedState.ui,
        view: "settings",
        lastNonSettingsView: "task",
        selectedThreadId: null,
        selectedTaskId: null,
      },
    });

    expect(seed?.view).toBe("settings");
    expect(seed?.lastNonSettingsView).toBe("task");
    expect(seed?.selectedTaskId).toBeNull();
    expect(seed?.selectedThreadId).toBeNull();
  });

  test("buildCachedDesktopStateSeed clears stale task context when chat startup falls back to ordinary chat", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "task-session-1",
            sessionId: "task-session-1",
            title: "Task thread",
            taskId: "task-1",
            taskThreadId: "task-thread-1",
          },
          {
            ...cachedState.persistedState.threads[0],
            id: "chat-session-1",
            sessionId: "chat-session-1",
            title: "Ordinary chat",
            lastMessageAt: "2026-03-19T01:00:00.000Z",
          },
        ],
      },
      ui: {
        ...cachedState.ui,
        view: "chat",
        selectedThreadId: "task-session-1",
        selectedTaskId: "task-1",
      },
    });

    expect(seed?.view).toBe("chat");
    expect(seed?.selectedThreadId).toBe("chat-session-1");
    expect(seed?.selectedTaskId).toBeNull();
  });

  test("buildCachedDesktopStateSeed restores normalized privacy telemetry settings", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        privacyTelemetrySettings: {
          crashReportsEnabled: true,
          aiTraceTelemetryEnabled: false,
          aiTracePayloadsEnabled: true,
          diagnosticsUploadEnabled: true,
        },
      },
    });

    expect(seed?.privacyTelemetrySettings).toEqual({
      crashReportsEnabled: true,
      productAnalyticsEnabled: false,
      aiTraceTelemetryEnabled: false,
      aiTracePayloadsEnabled: false,
      diagnosticsUploadEnabled: true,
      cloudSyncEnabled: false,
    });
  });

  test("buildCachedDesktopStateSeed falls back from remote access when the feature is unavailable", () => {
    remoteAccessEnabled = false;
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      ui: {
        ...cachedState.ui,
        view: "settings",
        settingsPage: "remoteAccess",
        lastNonSettingsView: "chat",
      },
    });

    expect(seed?.view).toBe("settings");
    expect(seed?.settingsPage).toBe("models");
  });

  test("buildCachedDesktopStateSeed preserves remote access page when persisted overrides enable it", () => {
    remoteAccessEnabled = false;
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        desktopFeatureFlagOverrides: {
          remoteAccess: true,
        },
      },
      ui: {
        ...cachedState.ui,
        view: "settings",
        settingsPage: "remoteAccess",
        lastNonSettingsView: "chat",
      },
    });

    expect(seed?.view).toBe("settings");
    expect(seed?.settingsPage).toBe("remoteAccess");
  });

  test("buildCachedDesktopStateSeed preserves the subagents settings page", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      ui: {
        ...cachedState.ui,
        view: "settings",
        settingsPage: "subagents",
        lastNonSettingsView: "chat",
      },
    });

    expect(seed?.view).toBe("settings");
    expect(seed?.settingsPage).toBe("subagents");
  });

  test("buildCachedDesktopStateSeed falls back from feature flags during packaged startup", () => {
    packagedApp = true;
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      ui: {
        ...cachedState.ui,
        view: "settings",
        settingsPage: "featureFlags",
        lastNonSettingsView: "chat",
      },
    });

    expect(seed?.view).toBe("settings");
    expect(seed?.settingsPage).toBe("models");
    expect(seed?.desktopFeatureFlags.remoteAccess).toBe(false);
  });

  test("buildCachedDesktopStateSeed accepts legacy cached payloads", () => {
    const seed = buildCachedDesktopStateSeed(legacyCachedState);
    expect(seed?.selectedWorkspaceId).toBe("ws-cached");
    expect(seed?.selectedThreadId).toBe("thread-cached");
    expect(seed?.view).toBe("settings");
    expect(seed?.workspaces?.[0]?.wsProtocol).toBe("jsonrpc");
  });

  test("buildCachedDesktopStateSeed ignores retired legacy REMOVEDUI workspace flags", () => {
    const legacyWorkspaceShapes = [
      { defaultFeatureFlags: { REMOVEDUI: true } },
      { defaultEnableREMOVEDUI: true },
      { defaultFeatureFlags: { workspace: { REMOVEDUI: true } } },
    ];

    for (const legacyWorkspaceShape of legacyWorkspaceShapes) {
      const seed = buildCachedDesktopStateSeed({
        ...cachedState,
        persistedState: {
          ...cachedState.persistedState,
          workspaces: [
            {
              ...cachedState.persistedState.workspaces[0],
              ...legacyWorkspaceShape,
            },
          ],
        },
      });

      expect(seed?.desktopFeatureFlagOverrides?.REMOVEDUI).toBeUndefined();
    }
  });

  test("buildCachedDesktopStateSeed does not set legacy REMOVEDUI override when no legacy flag is present", () => {
    const seed = buildCachedDesktopStateSeed(cachedState);
    expect(seed?.desktopFeatureFlagOverrides?.REMOVEDUI).toBeUndefined();
  });

  test("buildCachedDesktopStateSeed ignores legacy plugin management workspace fields", () => {
    const seed = buildCachedDesktopStateSeed({
      ...cachedState,
      ui: {
        ...cachedState.ui,
        pluginManagementWorkspaceId: "ws-management",
        pluginManagementMode: "workspace",
      },
    });

    expect(seed).not.toHaveProperty("pluginManagementWorkspaceId");
    expect(seed?.selectedWorkspaceId).toBe("ws-cached");
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
    expect(RUNTIME.sessionSnapshots.get("thread-session")?.snapshot.title).toBe(
      "Cached Harness Snapshot",
    );
  });

  test("buildCachedDesktopStateSeed rebuilds valid snapshot fingerprints and ignores malformed entries", () => {
    RUNTIME.sessionSnapshots.set("stale-session", {
      fingerprint: { updatedAt: "2026-03-18T00:00:00.000Z", messageCount: 0, lastEventSeq: 0 },
      snapshot: makeCachedSessionSnapshot("stale-session"),
    });
    const validSnapshot = makeCachedSessionSnapshot("thread-session", {
      title: "Recovered Cached Snapshot",
    });
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
    expect(state.view).toBe("settings");
    expect(state.sidebarCollapsed).toBe(true);
  });

  test("init hydrates a settings-over-task cache written without the task-owned thread", async () => {
    const task = taskRecord();
    const taskThread = {
      ...cachedState.persistedState.threads[0],
      id: "task-session-1",
      workspaceId: "ws-live",
      sessionId: "task-session-1",
      title: "Task main",
      taskId: "task-1",
      taskThreadId: "task-thread-1",
    };
    const ordinaryThread = {
      ...cachedState.persistedState.threads[0],
      id: "thread-live",
      workspaceId: "ws-live",
      sessionId: null,
      title: "Live Thread",
    };

    useAppStore.setState({
      ready: true,
      bootstrapPending: false,
      workspaces: loadedState.workspaces,
      threads: [ordinaryThread, taskThread],
      selectedWorkspaceId: "ws-live",
      selectedThreadId: "task-session-1",
      selectedTaskId: "task-1",
      taskSummariesByWorkspaceId: { "ws-live": [taskSummary(task)] },
      tasksById: { "task-1": task },
      view: "settings",
      lastNonSettingsView: "task",
    });
    localStorageMock.clear();
    syncDesktopStateCacheNow(() => useAppStore.getState());

    const actualCache = JSON.parse([...storage.values()][0] ?? "null");
    expect(actualCache.ui.selectedThreadId).toBeNull();
    expect(actualCache.ui.selectedTaskId).toBe("task-1");
    expect(actualCache.ui.view).toBe("settings");
    expect(actualCache.ui.lastNonSettingsView).toBe("task");
    expect(actualCache.persistedState.threads.map((thread: { id: string }) => thread.id)).toEqual([
      "thread-live",
    ]);

    loadedState = actualCache.persistedState;
    taskListResponse = [taskSummary(task)];
    taskReadResponse = task;
    resetStoreToCachedSeed(actualCache);
    installTaskHydrationStub();

    expect(useAppStore.getState().view).toBe("settings");
    expect(useAppStore.getState().selectedTaskId).toBe("task-1");
    expect(useAppStore.getState().selectedThreadId).toBeNull();

    await useAppStore.getState().init();
    await waitForCondition(
      () =>
        useAppStore.getState().view === "settings" &&
        useAppStore.getState().selectedThreadId === "task-session-1" &&
        useAppStore.getState().tasksById["task-1"] !== undefined,
    );

    let state = useAppStore.getState();
    expect(socketRequests).toContain("task/list");
    expect(socketRequests).toContain("task/read");
    expect(state.view).toBe("settings");
    expect(state.lastNonSettingsView).toBe("task");
    expect(state.selectedWorkspaceId).toBe("ws-live");
    expect(state.selectedTaskId).toBe("task-1");
    expect(state.selectedThreadId).toBe("task-session-1");
    expect(state.tasksById["task-1"]?.title).toBe("Cached task");
    expect(state.threads.find((thread) => thread.id === "task-session-1")).toEqual(
      expect.objectContaining({
        workspaceId: "ws-live",
        taskId: "task-1",
        taskThreadId: "task-thread-1",
      }),
    );
    expect(state.threadRuntimeById["task-session-1"]).toBeDefined();

    state.closeSettings();
    state = useAppStore.getState();
    expect(state.view).toBe("task");
    expect(state.selectedTaskId).toBe("task-1");
    expect(state.selectedThreadId).toBe("task-session-1");
  });

  test("init keeps settings-over-chat scoped to ordinary chat", async () => {
    const settingsChatCache = {
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        workspaces: loadedState.workspaces,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "thread-live",
            workspaceId: "ws-live",
            title: "Live Thread",
          },
        ],
      },
      ui: {
        ...cachedState.ui,
        view: "settings",
        lastNonSettingsView: "chat",
        selectedWorkspaceId: "ws-live",
        selectedThreadId: "thread-live",
        selectedTaskId: "task-1",
      },
    };
    loadedState = settingsChatCache.persistedState;
    resetStoreToCachedSeed(settingsChatCache);
    installTaskHydrationStub();

    await useAppStore.getState().init();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = useAppStore.getState();
    expect(socketRequests).not.toContain("task/list");
    expect(socketRequests).not.toContain("task/read");
    expect(state.view).toBe("settings");
    expect(state.lastNonSettingsView).toBe("chat");
    expect(state.selectedThreadId).toBe("thread-live");
    expect(state.selectedTaskId).toBeNull();
  });

  test("init clears deleted settings-over-task selection without exposing chat fallback", async () => {
    const deletedTaskCache = {
      ...cachedState,
      persistedState: {
        ...cachedState.persistedState,
        workspaces: loadedState.workspaces,
        threads: [
          {
            ...cachedState.persistedState.threads[0],
            id: "thread-live",
            workspaceId: "ws-live",
            title: "Live Thread",
          },
        ],
      },
      ui: {
        ...cachedState.ui,
        view: "settings",
        lastNonSettingsView: "task",
        selectedWorkspaceId: "ws-live",
        selectedThreadId: null,
        selectedTaskId: "task-deleted",
      },
    };
    loadedState = deletedTaskCache.persistedState;
    taskListResponse = [];
    resetStoreToCachedSeed(deletedTaskCache);
    installTaskHydrationStub();

    await useAppStore.getState().init();
    await waitForCondition(
      () => socketRequests.includes("task/list") && useAppStore.getState().selectedTaskId === null,
    );

    let state = useAppStore.getState();
    expect(socketRequests).toContain("task/list");
    expect(socketRequests).not.toContain("task/read");
    expect(state.view).toBe("settings");
    expect(state.lastNonSettingsView).toBe("task");
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedThreadId).toBeNull();

    state.closeSettings();
    state = useAppStore.getState();
    expect(state.view).toBe("task");
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedThreadId).toBeNull();
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

  test("init restores the selected startup thread when requestAnimationFrame is throttled", async () => {
    installWindowMock({ requestAnimationFrame: mock(() => 1) });
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

    await waitForCondition(
      () => useAppStore.getState().threadRuntimeById["thread-live"]?.hydrating === false,
    );

    expect(useAppStore.getState().threadRuntimeById["thread-live"]?.hydrating).toBe(false);
  });

  test("init preserves cached state when authoritative load fails", async () => {
    loadStateError = new Error("state load exploded");
    const realError = console.error;
    console.error = mock(() => {});

    try {
      await useAppStore.getState().init();
    } finally {
      console.error = realError;
    }

    const state = useAppStore.getState();
    expect(state.bootstrapPending).toBe(false);
    expect(state.startupError).toContain("state load exploded");
    expect(state.workspaces[0]?.id).toBe("ws-cached");
    expect(state.selectedThreadId).toBe("thread-cached");
  });
});
