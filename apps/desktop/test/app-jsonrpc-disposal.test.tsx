import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  clearJsonRpcSocketOverride,
  NoopJsonRpcSocket,
  setJsonRpcSocketOverride,
} from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
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
let bootstrapLoadedState: unknown = { version: 2, workspaces: [], threads: [] };

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    appendTranscriptBatch: async () => {},
    appendTranscriptEvent: async () => {},
    deleteTranscript: async () => {
      bootstrapDeleteTranscriptCalls += 1;
    },
    listDirectory: async () => [],
    loadState: async () => {
      bootstrapLoadStateCalls += 1;
      return bootstrapLoadedState;
    },
    pickWorkspaceDirectory: async () => null,
    readTranscript: async () => [],
    saveState: async () => {
      bootstrapSaveStateCalls += 1;
    },
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
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: NoopJsonRpcSocket,
}));

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
const defaultStoreState = useAppStore.getState();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
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
    promptModal: null,
    onboardingVisible: false,
  });
  return { workspaceId, threadId };
}

function setupAppJsdom() {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  return setupJsdom({
    includeAnimationFrame: {
      requestAnimationFrame: (callback: FrameRequestCallback) =>
        setTimeout(() => callback(Date.now()), 0) as unknown as number,
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

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("App JSON-RPC shutdown disposal", () => {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    MockJsonRpcSocket.instances.length = 0;
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
    bootstrapLoadedState = { version: 2, workspaces: [], threads: [] };
    useAppStore.setState(defaultStoreState);
  });

  afterEach(() => {
    disposeAllJsonRpcState();
    clearJsonRpcSocketOverride();
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
        await flushAsyncWork();
        await flushAsyncWork();
      });

      expect(bootstrapLoadStateCalls).toBe(1);
      expect(bootstrapUpdateStateCalls).toBe(1);
      expect(bootstrapDeleteTranscriptCalls).toBe(1);
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
