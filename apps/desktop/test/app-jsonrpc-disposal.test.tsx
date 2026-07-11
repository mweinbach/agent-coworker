import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DESKTOP_API_OVERRIDE_KEY } from "../src/lib/desktopApiOverride";
import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import {
  createDesktopApiMock,
  createDesktopCommandsBridgeMock,
} from "./helpers/mockDesktopCommands";
import { setupJsdom } from "./jsdomHarness";

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
  lastCheckedAt: null,
  lastCheckStartedAt: null,
  downloadedAt: null,
  message: null,
  error: null,
  release: null,
  progress: null,
};

let workspaceServerExitedSubscriptions = 0;
let bootstrapLoadStateCalls = 0;
let bootstrapUpdateStateCalls = 0;
let bootstrapSaveStateCalls = 0;
let bootstrapDeleteTranscriptCalls = 0;
let bootstrapStartWorkspaceServerCalls = 0;
let bootstrapSelectThreadCalls = 0;
let bootstrapLoadedState: unknown = { version: 2, workspaces: [], threads: [] };
let bootstrapLoadStateImplementation: () => Promise<unknown> = async () => bootstrapLoadedState;
let bootstrapStartWorkspaceServerImplementation: () => Promise<{ url: string }> = async () => ({
  url: "ws://mock",
});

const desktopApiMock = createDesktopApiMock({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {
    bootstrapDeleteTranscriptCalls += 1;
  },
  listDirectory: async () => [],
  loadState: async () => {
    bootstrapLoadStateCalls += 1;
    return await bootstrapLoadStateImplementation();
  },
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {
    bootstrapSaveStateCalls += 1;
  },
  startWorkspaceServer: async () => {
    bootstrapStartWorkspaceServerCalls += 1;
    return await bootstrapStartWorkspaceServerImplementation();
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
  getUpdateState: async () => {
    bootstrapUpdateStateCalls += 1;
    return MOCK_UPDATE_STATE;
  },
  checkForUpdates: async () => {},
  quitAndInstallUpdate: async () => {},
  onSystemAppearanceChanged: () => () => {},
  onMenuCommand: () => () => {},
  onUpdateStateChanged: () => () => {},
  onWorkspaceServerExited: () => {
    workspaceServerExitedSubscriptions += 1;
    return () => {
      workspaceServerExitedSubscriptions -= 1;
    };
  },
});

(globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
mock.module("../src/lib/desktopCommands", () => createDesktopCommandsBridgeMock());

const { useAppStore } = await import("../src/app/store");
const App = (await import("../src/App")).default;
const {
  RUNTIME,
  __controlSocketInternal,
  __threadEventReducerInternal,
  defaultThreadRuntime,
  defaultWorkspaceRuntime,
  disposeAllJsonRpcState,
  ensureControlSocket,
  ensureThreadSocket,
} = await import("../src/app/store.helpers");
const { __internal: jsonRpcSocketInternal } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);
const defaultStoreState = useAppStore.getInitialState();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  static requestImplementation:
    | ((method: string, params?: unknown) => unknown | Promise<unknown>)
    | null = null;
  readonly readyPromise = Promise.resolve();
  closed = false;

  constructor(
    public readonly opts: {
      url?: string;
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

  async request(method: string, params?: any) {
    if (MockJsonRpcSocket.requestImplementation) {
      return await MockJsonRpcSocket.requestImplementation(method, params);
    }
    if (method === "thread/resume" || method === "thread/start") {
      const sessionId = typeof params?.threadId === "string" ? params.threadId : "session-1";
      return {
        thread: {
          id: sessionId,
          title: "Live thread",
          modelProvider: "openai",
          model: "gpt-5.2",
          cwd: "/tmp/workspace",
          createdAt: "2026-03-22T00:00:00.000Z",
          updatedAt: "2026-03-22T00:00:01.000Z",
          status: { type: "loaded" },
        },
      };
    }
    if (method === "thread/read") {
      return { coworkSnapshot: null };
    }
    if (method === "thread/list") {
      return { threads: [] };
    }
    return {};
  }

  respond() {
    return true;
  }

  close() {
    this.closed = true;
    this.opts.onClose?.();
  }
}

function seedWorkspaceState() {
  const workspaceId = "ws-app-shutdown";
  const threadId = "thread-app-shutdown";
  useAppStore.setState({
    ready: true,
    bootstrapPhase: "ready",
    startupError: null,
    view: "chat",
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        path: "/tmp/workspace",
        createdAt: "2026-03-22T00:00:00.000Z",
        lastOpenedAt: "2026-03-22T00:00:00.000Z",
        defaultProvider: "openai",
        defaultModel: "gpt-5.2",
        defaultPreferredChildModel: "gpt-5.2",
        defaultPreferredChildModelRef: "openai:gpt-5.2",
        defaultAllowedChildModelRefs: [],
        defaultChildModelRoutingMode: "same-provider",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        wsProtocol: "jsonrpc",
        yolo: false,
      },
    ],
    threads: [
      {
        id: threadId,
        workspaceId,
        title: "Live thread",
        titleSource: "manual",
        createdAt: "2026-03-22T00:00:00.000Z",
        lastMessageAt: "2026-03-22T00:00:01.000Z",
        status: "active",
        sessionId: "session-1",
        messageCount: 1,
        lastEventSeq: 1,
        draft: false,
        legacyTranscriptId: null,
      },
    ],
    selectedWorkspaceId: workspaceId,
    selectedThreadId: null,
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock",
      },
    },
    threadRuntimeById: {
      [threadId]: {
        ...defaultThreadRuntime(),
        wsUrl: "ws://mock",
        connected: true,
        sessionId: "session-1",
      },
    },
    notifications: [],
    interactionsByThread: {},
    onboardingVisible: false,
  });
  return { workspaceId, threadId };
}

function setupAppJsdom(
  requestAnimationFrame: (callback: FrameRequestCallback) => number = (callback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
) {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  return setupJsdom({
    includeAnimationFrame: {
      requestAnimationFrame,
      cancelAnimationFrame: (id: number) => clearTimeout(id),
    },
    extraGlobals: {
      ResizeObserver: MockResizeObserver,
    },
    setupWindow: (dom) => {
      if (typeof dom.window.HTMLElement.prototype.attachEvent !== "function") {
        (dom.window.HTMLElement.prototype as { attachEvent?: () => void }).attachEvent = () => {};
      }
      if (typeof dom.window.HTMLElement.prototype.detachEvent !== "function") {
        (dom.window.HTMLElement.prototype as { detachEvent?: () => void }).detachEvent = () => {};
      }
    },
  });
}

async function runNextPaint(paintCallbacks: FrameRequestCallback[]): Promise<void> {
  await waitForCondition(() => paintCallbacks.length > 0);
  const callback = paintCallbacks.shift();
  if (!callback) {
    throw new Error("Expected a pending paint callback");
  }
  callback(Date.now());
  await flushAsyncWork();
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return;
    }
    await flushAsyncWork();
  }
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("App JSON-RPC shutdown disposal", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY] = desktopApiMock;
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    MockJsonRpcSocket.instances.length = 0;
    MockJsonRpcSocket.requestImplementation = null;
    jsonRpcSocketInternal.reset();
    __controlSocketInternal.reset();
    __threadEventReducerInternal.reset();
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.providerStatusRefreshGeneration = 0;
    workspaceServerExitedSubscriptions = 0;
    bootstrapLoadStateCalls = 0;
    bootstrapUpdateStateCalls = 0;
    bootstrapSaveStateCalls = 0;
    bootstrapDeleteTranscriptCalls = 0;
    bootstrapStartWorkspaceServerCalls = 0;
    bootstrapSelectThreadCalls = 0;
    bootstrapLoadedState = { version: 2, workspaces: [], threads: [] };
    bootstrapLoadStateImplementation = async () => bootstrapLoadedState;
    bootstrapStartWorkspaceServerImplementation = async () => ({ url: "ws://mock" });
    useAppStore.setState(defaultStoreState);
  });

  afterEach(async () => {
    await useAppStore.getState().drainBootstrap();
    disposeAllJsonRpcState();
    delete (globalThis as Record<string, unknown>)[DESKTOP_API_OVERRIDE_KEY];
    clearJsonRpcSocketOverride();
    MockJsonRpcSocket.requestImplementation = null;
    jsonRpcSocketInternal.reset();
    __controlSocketInternal.reset();
    __threadEventReducerInternal.reset();
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    workspaceServerExitedSubscriptions = 0;
    useAppStore.setState(defaultStoreState);
  });

  test("transient renderer unmount keeps workspace JSON-RPC listeners alive", async () => {
    const harness = setupAppJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const { workspaceId, threadId } = seedWorkspaceState();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
      });

      await act(async () => {
        ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
        ensureThreadSocket(
          useAppStore.getState as any,
          useAppStore.setState as any,
          threadId,
          "ws://mock",
        );
        await flushAsyncWork();
      });

      expect(
        jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId).routerCount,
      ).toBeGreaterThan(0);
      expect(
        jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId).lifecycleListenerCount,
      ).toBeGreaterThan(0);
      expect(RUNTIME.jsonRpcSockets.has(workspaceId)).toBe(true);

      await act(async () => {
        root?.unmount();
        await flushAsyncWork();
      });
      root = null;

      const socketState = jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId);
      expect(socketState.isDisposed).toBe(false);
      expect(socketState.hasStoreSetter).toBe(true);
      expect(socketState.routerCount).toBeGreaterThan(0);
      expect(socketState.lifecycleListenerCount).toBeGreaterThan(0);
      expect(__controlSocketInternal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
        isDisposed: false,
        hasRouterCleanup: true,
        hasLifecycleCleanup: true,
        hasBootstrapPromise: false,
        hasStoreGetter: true,
        hasStoreSetter: true,
      });
      expect(__threadEventReducerInternal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
        isDisposed: false,
        hasRouterCleanup: true,
        hasLifecycleCleanup: true,
        reconnectThreadIds: [threadId],
      });
      expect(RUNTIME.jsonRpcSockets.has(workspaceId)).toBe(true);
      expect(RUNTIME.workspaceJsonRpcSocketGenerations.has(workspaceId)).toBe(true);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("Strict Mode mount runs one authoritative bootstrap side-effect pass", async () => {
    const harness = setupAppJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      bootstrapLoadedState = {
        version: 2,
        workspaces: [
          {
            id: "ws-bootstrap",
            name: "Bootstrap workspace",
            path: "/tmp/bootstrap",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-current",
            workspaceId: "ws-bootstrap",
            title: "Current thread",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastMessageAt: "2026-01-02T00:00:00.000Z",
            status: "active",
            sessionId: null,
            messageCount: 0,
            lastEventSeq: 0,
          },
          {
            id: "thread-archived",
            workspaceId: "ws-bootstrap",
            title: "Archived thread",
            createdAt: "2025-01-01T00:00:00.000Z",
            lastMessageAt: "2025-01-02T00:00:00.000Z",
            status: "disconnected",
            sessionId: "thread-archived",
            messageCount: 0,
            lastEventSeq: 0,
            archived: true,
            archivedAt: "2025-01-02T00:00:00.000Z",
          },
        ],
        desktopSettings: { archivedChatsAutoDeleteDays: 1 },
      };
      const selectThread = async (threadId: string) => {
        expect(threadId).toBe("thread-current");
        bootstrapSelectThreadCalls += 1;
      };
      useAppStore.setState({
        ...defaultStoreState,
        ready: false,
        bootstrapPhase: "idle",
        startupError: null,
        view: "chat",
        lastNonSettingsView: "chat",
        selectThread,
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
      });
      await act(async () => {
        await useAppStore.getState().drainBootstrap();
      });

      expect(bootstrapLoadStateCalls).toBe(1);
      expect(bootstrapUpdateStateCalls).toBe(1);
      expect(bootstrapDeleteTranscriptCalls).toBe(1);
      expect(useAppStore.getState().selectThread).toBe(selectThread);
      expect(useAppStore.getState().startupError).toBeNull();
      expect(useAppStore.getState().bootstrapPhase).toBe("ready");
      expect(useAppStore.getState().selectedThreadId).toBe("thread-current");
      expect(bootstrapSelectThreadCalls).toBe(1);
      expect(bootstrapSaveStateCalls).toBe(1);
      expect(useAppStore.getState().selectedThreadId).toBe("thread-current");
      expect(useAppStore.getState().view).toBe("chat");
      expect(useAppStore.getState().threadRuntimeById["thread-current"]?.hydrating).toBe(true);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("window unload invalidates a deferred bootstrap before later writes or startup", async () => {
    const harness = setupAppJsdom();
    const authoritativeLoad = createDeferred<unknown>();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      bootstrapLoadedState = {
        version: 2,
        workspaces: [
          {
            id: "ws-deferred",
            name: "Deferred workspace",
            path: "/tmp/deferred",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-deferred",
            workspaceId: "ws-deferred",
            title: "Deferred thread",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastMessageAt: "2026-01-02T00:00:00.000Z",
            status: "active",
            sessionId: null,
            messageCount: 0,
            lastEventSeq: 0,
          },
          {
            id: "thread-archived",
            workspaceId: "ws-deferred",
            title: "Archived thread",
            createdAt: "2025-01-01T00:00:00.000Z",
            lastMessageAt: "2025-01-02T00:00:00.000Z",
            status: "disconnected",
            sessionId: "thread-archived",
            messageCount: 0,
            lastEventSeq: 0,
            archived: true,
            archivedAt: "2025-01-02T00:00:00.000Z",
          },
        ],
        desktopSettings: { archivedChatsAutoDeleteDays: 1 },
      };
      bootstrapLoadStateImplementation = () => authoritativeLoad.promise;
      useAppStore.setState({
        ...defaultStoreState,
        ready: false,
        bootstrapPhase: "idle",
        startupError: null,
        view: "chat",
        lastNonSettingsView: "chat",
        selectThread: async () => {
          bootstrapSelectThreadCalls += 1;
        },
      });
      const stateBeforeBootstrap = useAppStore.getState();
      const expectedWorkspaces = stateBeforeBootstrap.workspaces;
      const expectedThreads = stateBeforeBootstrap.threads;
      const expectedSelectedWorkspaceId = stateBeforeBootstrap.selectedWorkspaceId;
      const expectedSelectedThreadId = stateBeforeBootstrap.selectedThreadId;
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
        await flushAsyncWork();
      });

      expect(bootstrapLoadStateCalls).toBe(1);
      expect(useAppStore.getState().bootstrapPhase).toBe("loading");
      const pendingBootstrap = useAppStore.getState().init();

      await act(async () => {
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("beforeunload"));
        expect(useAppStore.getState().init()).toBe(pendingBootstrap);
        authoritativeLoad.resolve(bootstrapLoadedState);
        await flushAsyncWork();
        await flushAsyncWork();
      });

      expect(bootstrapLoadStateCalls).toBe(1);
      expect(bootstrapUpdateStateCalls).toBe(0);
      expect(bootstrapDeleteTranscriptCalls).toBe(0);
      expect(bootstrapSaveStateCalls).toBe(0);
      expect(bootstrapSelectThreadCalls).toBe(0);
      expect(bootstrapStartWorkspaceServerCalls).toBe(0);
      expect(useAppStore.getState().workspaces).toEqual(expectedWorkspaces);
      expect(useAppStore.getState().threads).toEqual(expectedThreads);
      expect(useAppStore.getState().selectedWorkspaceId).toBe(expectedSelectedWorkspaceId);
      expect(useAppStore.getState().selectedThreadId).toBe(expectedSelectedThreadId);
      expect(useAppStore.getState().ready).toBe(false);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("window unload aborts deferred startup selection before it can restore JSON-RPC state", async () => {
    const paintCallbacks: FrameRequestCallback[] = [];
    const harness = setupAppJsdom((callback) => {
      paintCallbacks.push(callback);
      return paintCallbacks.length;
    });
    const deferredServerStart = createDeferred<{ url: string }>();
    let root: ReturnType<typeof createRoot> | null = null;
    const workspaceId = "ws-deferred-selection";

    try {
      bootstrapLoadedState = {
        version: 2,
        workspaces: [
          {
            id: workspaceId,
            name: "Deferred selection workspace",
            path: "/tmp/deferred-selection",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [
          {
            id: "thread-deferred-selection",
            workspaceId,
            title: "Deferred selection thread",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastMessageAt: "2026-01-02T00:00:00.000Z",
            status: "active",
            sessionId: "session-deferred-selection",
            messageCount: 1,
            lastEventSeq: 1,
          },
        ],
      };
      bootstrapStartWorkspaceServerImplementation = () => deferredServerStart.promise;
      useAppStore.setState({
        ...defaultStoreState,
        ready: false,
        bootstrapPhase: "idle",
        startupError: null,
        view: "chat",
        lastNonSettingsView: "chat",
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
      });
      await act(async () => {
        await waitForCondition(() => useAppStore.getState().bootstrapPhase === "ready");
        await runNextPaint(paintCallbacks);
        await runNextPaint(paintCallbacks);
        await waitForCondition(() => bootstrapStartWorkspaceServerCalls === 1);
      });

      expect(bootstrapStartWorkspaceServerCalls).toBe(1);
      expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.starting).toBe(true);
      await act(async () => {
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [workspaceId]: {
              ...state.workspaceRuntimeById[workspaceId],
              serverUrl: "ws://existing",
            },
          },
        }));
        ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
        ensureThreadSocket(
          useAppStore.getState as any,
          useAppStore.setState as any,
          "session-deferred-selection",
          "ws://existing",
        );
        await flushAsyncWork();
        useAppStore.setState((state) => ({
          workspaceRuntimeById: {
            ...state.workspaceRuntimeById,
            [workspaceId]: {
              ...state.workspaceRuntimeById[workspaceId],
              serverUrl: null,
            },
          },
        }));
      });
      expect(MockJsonRpcSocket.instances).toHaveLength(1);

      await act(async () => {
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("beforeunload"));
        deferredServerStart.resolve({ url: "ws://late-server" });
        await useAppStore.getState().drainBootstrap();
      });

      expect(bootstrapStartWorkspaceServerCalls).toBe(1);
      expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.serverUrl).toBeNull();
      expect(RUNTIME.jsonRpcSockets.size).toBe(0);
      expect(MockJsonRpcSocket.instances).toHaveLength(1);
      expect(MockJsonRpcSocket.instances[0]?.closed).toBe(true);
      expect(jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId).isDisposed).toBe(true);
      expect(__controlSocketInternal.getWorkspaceStateSnapshot(workspaceId).isDisposed).toBe(true);
      expect(__threadEventReducerInternal.getWorkspaceStateSnapshot(workspaceId).isDisposed).toBe(
        true,
      );
    } finally {
      deferredServerStart.resolve({ url: "ws://cleanup" });
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("window unload rejects a deferred startup session refresh before it can write", async () => {
    const paintCallbacks: FrameRequestCallback[] = [];
    const harness = setupAppJsdom((callback) => {
      paintCallbacks.push(callback);
      return paintCallbacks.length;
    });
    const deferredThreadList = createDeferred<unknown>();
    let threadListRequests = 0;
    let root: ReturnType<typeof createRoot> | null = null;
    const workspaceId = "ws-deferred-sessions";

    try {
      bootstrapLoadedState = {
        version: 2,
        workspaces: [
          {
            id: workspaceId,
            name: "Deferred sessions workspace",
            path: "/tmp/deferred-sessions",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-02T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: false,
            yolo: false,
          },
        ],
        threads: [],
      };
      MockJsonRpcSocket.requestImplementation = async (method) => {
        if (method === "thread/list") {
          threadListRequests += 1;
          return await deferredThreadList.promise;
        }
        return {};
      };
      useAppStore.setState({
        ...defaultStoreState,
        ready: false,
        bootstrapPhase: "idle",
        startupError: null,
        view: "chat",
        lastNonSettingsView: "chat",
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
      });
      await act(async () => {
        await waitForCondition(() => useAppStore.getState().bootstrapPhase === "ready");
        await runNextPaint(paintCallbacks);
        await waitForCondition(() => threadListRequests > 0);
      });

      expect(bootstrapStartWorkspaceServerCalls).toBe(1);
      expect(threadListRequests).toBeGreaterThan(0);
      expect(MockJsonRpcSocket.instances).toHaveLength(1);

      await act(async () => {
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("beforeunload"));
        deferredThreadList.resolve({
          threads: [
            {
              id: "late-session",
              title: "Late session",
              modelProvider: "openai",
              model: "gpt-5.2",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
        });
        await useAppStore.getState().drainBootstrap();
      });

      expect(useAppStore.getState().threads).toEqual([]);
      expect(bootstrapStartWorkspaceServerCalls).toBe(1);
      expect(RUNTIME.jsonRpcSockets.size).toBe(0);
      expect(MockJsonRpcSocket.instances).toHaveLength(1);
      expect(MockJsonRpcSocket.instances[0]?.closed).toBe(true);
      expect(jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId).isDisposed).toBe(true);
      expect(__controlSocketInternal.getWorkspaceStateSnapshot(workspaceId).isDisposed).toBe(true);
    } finally {
      deferredThreadList.resolve({ threads: [] });
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("window unload disposes all workspace JSON-RPC listeners", async () => {
    const harness = setupAppJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      const { workspaceId, threadId } = seedWorkspaceState();
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
      });

      await act(async () => {
        ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
        ensureThreadSocket(
          useAppStore.getState as any,
          useAppStore.setState as any,
          threadId,
          "ws://mock",
        );
        await flushAsyncWork();
      });

      expect(
        jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId).routerCount,
      ).toBeGreaterThan(0);
      expect(
        jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId).lifecycleListenerCount,
      ).toBeGreaterThan(0);
      expect(RUNTIME.jsonRpcSockets.has(workspaceId)).toBe(true);

      await act(async () => {
        harness.dom.window.dispatchEvent(new harness.dom.window.Event("beforeunload"));
        await flushAsyncWork();
      });

      expect(jsonRpcSocketInternal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
        isDisposed: true,
        hasStoreSetter: false,
        routerCount: 0,
        lifecycleListenerCount: 0,
      });
      expect(__controlSocketInternal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
        isDisposed: true,
        hasRouterCleanup: false,
        hasLifecycleCleanup: false,
        hasBootstrapPromise: false,
        hasStoreGetter: false,
        hasStoreSetter: false,
      });
      expect(__threadEventReducerInternal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
        isDisposed: true,
        hasRouterCleanup: false,
        hasLifecycleCleanup: false,
        reconnectThreadIds: [],
      });
      expect(RUNTIME.jsonRpcSockets.size).toBe(0);
      expect(RUNTIME.workspaceJsonRpcSocketGenerations.size).toBe(0);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });

  test("does not render onboarding overlay in popup window modes", async () => {
    const harness = setupAppJsdom();
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      harness.dom.reconfigure({ url: "http://localhost/?window=quick-chat" });
      seedWorkspaceState();
      useAppStore.setState({
        onboardingVisible: true,
        onboardingStep: "welcome",
      });
      const container = harness.dom.window.document.getElementById("root");
      if (!container) {
        throw new Error("missing root");
      }
      root = createRoot(container);

      await act(async () => {
        root?.render(createElement(StrictMode, null, createElement(App)));
        await flushAsyncWork();
      });

      expect(harness.dom.window.document.querySelector('[aria-label="Onboarding"]')).toBeNull();
      expect(workspaceServerExitedSubscriptions).toBe(0);
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
      harness.restore();
    }
  });
});
