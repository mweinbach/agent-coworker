import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcActivityLog: string[] = [];
const jsonRpcResponseOverrides = new Map<
  string,
  (params?: unknown) => unknown | Promise<unknown>
>();
const transcriptBatches: Array<
  Array<{
    ts: string;
    threadId: string;
    direction: "server" | "client";
    payload: unknown;
  }>
> = [];
let mockedLoadedState: any = { version: 2, workspaces: [], threads: [] };

export function setMockedLoadedState(state: typeof mockedLoadedState) {
  mockedLoadedState = state;
}

export function getMockedLoadedState() {
  return mockedLoadedState;
}
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject } satisfies Deferred<T>;
}

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();

  constructor(
    public readonly opts: {
      onOpen?: () => void;
      onClose?: () => void;
      onNotification?: (message: any) => void;
    },
  ) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    jsonRpcActivityLog.push(`request:${method}`);
    const override = jsonRpcResponseOverrides.get(method);
    if (override) {
      return await override(params);
    }

    if (method === "thread/list") {
      const cwd =
        params &&
        typeof params === "object" &&
        typeof (params as { cwd?: unknown }).cwd === "string"
          ? (params as { cwd: string }).cwd
          : null;
      const workspaceId = cwd
        ? (mockedLoadedState.workspaces?.find(
            (workspace: { path?: string; id?: string }) => workspace.path === cwd,
          )?.id ?? null)
        : null;
      const threads = workspaceId
        ? (mockedLoadedState.threads ?? [])
            .filter(
              (thread: { workspaceId?: string; sessionId?: string | null }) =>
                thread.workspaceId === workspaceId &&
                typeof thread.sessionId === "string" &&
                thread.sessionId.trim().length > 0,
            )
            .map(
              (thread: {
                title?: string;
                sessionId: string;
                createdAt?: string;
                lastMessageAt?: string;
              }) => ({
                id: thread.sessionId,
                title: thread.title ?? "Recovered thread",
                modelProvider: "openai",
                model: "gpt-5.2",
                cwd: cwd ?? "/tmp/workspace",
                createdAt: thread.createdAt ?? "2024-01-01T00:00:00.000Z",
                updatedAt: thread.lastMessageAt ?? "2024-01-01T00:00:02.000Z",
                status: { type: "loaded" },
              }),
            )
        : [];
      return { threads };
    }

    if (method === "thread/read") {
      const threadId =
        params &&
        typeof params === "object" &&
        typeof (params as { threadId?: unknown }).threadId === "string"
          ? (params as { threadId: string }).threadId
          : "thread-session";
      const persistedThread = (mockedLoadedState.threads ?? []).find(
        (thread: { sessionId?: string | null }) => thread.sessionId === threadId,
      );
      return {
        coworkSnapshot: makeSessionSnapshot(threadId, {
          title: persistedThread?.title ?? "Harness Snapshot Thread",
        }),
      };
    }

    if (method === "thread/resume") {
      const threadId =
        params &&
        typeof params === "object" &&
        typeof (params as { threadId?: unknown }).threadId === "string"
          ? (params as { threadId: string }).threadId
          : "thread-session";
      const persistedThread = (mockedLoadedState.threads ?? []).find(
        (thread: { sessionId?: string | null }) => thread.sessionId === threadId,
      );
      return {
        thread: {
          id: threadId,
          title: persistedThread?.title ?? "Recovered thread",
          modelProvider: "openai",
          model: "gpt-5.2",
          cwd: "/tmp/workspace",
          createdAt: persistedThread?.createdAt ?? "2024-01-01T00:00:00.000Z",
          updatedAt: persistedThread?.lastMessageAt ?? "2024-01-01T00:00:02.000Z",
          status: { type: "loaded" },
        },
      };
    }

    if (method === "cowork/provider/catalog/read") {
      return {
        event: {
          type: "provider_catalog",
          sessionId: "jsonrpc-control",
          all: [],
          default: {},
          connected: [],
        },
      };
    }

    if (method === "cowork/provider/authMethods/read") {
      return {
        event: {
          type: "provider_auth_methods",
          sessionId: "jsonrpc-control",
          methods: {},
        },
      };
    }

    if (method === "cowork/provider/status/refresh") {
      return {
        event: {
          type: "provider_status",
          sessionId: "jsonrpc-control",
          providers: [],
        },
      };
    }

    if (method === "cowork/mcp/servers/read") {
      return {
        event: {
          type: "mcp_servers",
          sessionId: "jsonrpc-control",
          servers: [],
          legacy: {
            workspace: { path: "/tmp/workspace/.cowork/mcp-servers.json", exists: false },
            user: { path: "/tmp/.cowork/mcp-servers.json", exists: false },
          },
          files: [],
        },
      };
    }

    if (method === "cowork/memory/list") {
      return {
        event: {
          type: "memory_list",
          sessionId: "jsonrpc-control",
          memories: [],
        },
      };
    }

    if (method === "cowork/skills/catalog/read") {
      return {
        event: {
          type: "skills_catalog",
          sessionId: "jsonrpc-control",
          catalog: {
            installations: [],
            sources: [],
            stats: { totalInstallations: 0, enabledInstallations: 0 },
          },
          mutationBlocked: false,
        },
      };
    }

    if (method === "cowork/skills/list") {
      return {
        event: {
          type: "skills_list",
          sessionId: "jsonrpc-control",
          skills: [],
        },
      };
    }

    if (method === "cowork/session/defaults/apply") {
      return {
        event: {
          type: "session_config",
          sessionId: "jsonrpc-control",
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
      };
    }

    if (method === "cowork/session/state/read") {
      return {
        events: [
          {
            type: "config_updated",
            sessionId: "jsonrpc-control",
            config: {
              provider: "openai",
              model: "gpt-5.2",
              workingDirectory: "/tmp/workspace",
            },
          },
          {
            type: "session_settings",
            sessionId: "jsonrpc-control",
            enableMcp: true,
            enableMemory: true,
            memoryRequireApproval: false,
          },
          {
            type: "session_config",
            sessionId: "jsonrpc-control",
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
        ],
      };
    }

    return {};
  }

  respond() {
    return true;
  }

  close() {
    jsonRpcActivityLog.push("close");
    this.opts.onClose?.();
  }

  notify(method: string, params?: unknown) {
    this.opts.onNotification?.({ method, params });
  }
}

function installWorkspaceSettingsSyncMocks() {
  mock.module("../src/lib/desktopCommands", () =>
    createDesktopCommandsMock({
      appendTranscriptBatch: async (
        events: Array<{
          ts: string;
          threadId: string;
          direction: "server" | "client";
          payload: unknown;
        }>,
      ) => {
        transcriptBatches.push(events);
      },
      appendTranscriptEvent: async () => {},
      deleteTranscript: async () => {},
      listDirectory: async () => [],
      loadState: async () => mockedLoadedState,
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
    }),
  );

  mock.module("../src/lib/agentSocket", () => ({
    JsonRpcSocket: MockJsonRpcSocket,
  }));
}

installWorkspaceSettingsSyncMocks();

const { useAppStore } = await import("../src/app/store");
const {
  RUNTIME,
  __controlSocketInternal,
  __threadEventReducerInternal,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadSocket,
  requestJsonRpcControlEvent,
} = await import("../src/app/store.helpers");
const { __internal: jsonRpcSocketInternal } = await import(
  "../src/app/store.helpers/jsonRpcSocket"
);

function requestsFor(method: string) {
  return jsonRpcRequests.filter((entry) => entry.method === method);
}

function latestRequest(method: string) {
  return requestsFor(method).at(-1) ?? null;
}

function getWorkspaceJsonRpcHelperState(targetWorkspaceId: string) {
  return {
    socket: jsonRpcSocketInternal.getWorkspaceStateSnapshot(targetWorkspaceId),
    control: __controlSocketInternal.getWorkspaceStateSnapshot(targetWorkspaceId),
    thread: __threadEventReducerInternal.getWorkspaceStateSnapshot(targetWorkspaceId),
  };
}

function setControlSessionConfigResponse(config: Record<string, unknown>) {
  jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => ({
    event: {
      type: "session_config",
      sessionId: "jsonrpc-control",
      config,
    },
  }));
}

function primeWorkspaceConnection() {
  const workspaceId =
    useAppStore.getState().selectedWorkspaceId ?? useAppStore.getState().workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error("expected workspace");
  }
  useAppStore.setState((state) => ({
    ...state,
    workspaceRuntimeById: {
      ...state.workspaceRuntimeById,
      [workspaceId]: {
        ...state.workspaceRuntimeById[workspaceId],
        serverUrl: "ws://mock",
        starting: false,
        error: null,
      },
    },
  }));
}

function syncMockedWorkspaceSessions() {
  const state = useAppStore.getState();
  mockedLoadedState = {
    version: 2,
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.id,
      path: workspace.path,
    })),
    threads: state.threads.map((thread) => ({ ...thread })),
  };
}

function seedConnectedThread(overrides: Partial<Record<string, unknown>> = {}) {
  const workspaceId =
    useAppStore.getState().selectedWorkspaceId ?? useAppStore.getState().workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error("expected workspace");
  }
  const threadId = `thread-${crypto.randomUUID()}`;
  const sessionId = String(overrides.sessionId ?? `session-${crypto.randomUUID()}`);
  useAppStore.setState((state) => ({
    ...(state as any),
    threads: [
      ...state.threads,
      {
        id: threadId,
        workspaceId,
        title: "Live thread",
        titleSource: "manual",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastMessageAt: "2024-01-01T00:00:02.000Z",
        status: "active",
        sessionId,
        messageCount: 2,
        lastEventSeq: 4,
        draft: false,
        legacyTranscriptId: null,
      },
    ],
    threadRuntimeById: {
      ...state.threadRuntimeById,
      [threadId]: {
        wsUrl: "ws://mock",
        connected: true,
        sessionId,
        config: {
          provider: "openai",
          model: "gpt-5.2",
          workingDirectory: "/tmp/workspace",
          outputDirectory: "/tmp/workspace/output",
        },
        sessionConfig: {
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
          ...(overrides.sessionConfig ?? {}),
        },
        enableMcp: overrides.enableMcp ?? true,
        feed: [],
        hydrating: false,
        transcriptOnly: false,
        busy: overrides.busy ?? false,
        busySince: null,
        activeTurnId: null,
        pendingSteer: null,
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
        lastMessagePreview: "Live thread",
        agents: [],
        sessionUsage: null,
        lastTurnUsage: null,
        draftComposerProvider: null,
        draftComposerModel: null,
      },
    },
  }));
  return { threadId, sessionId };
}

function makeSessionSnapshot(sessionId: string, overrides: Partial<Record<string, unknown>> = {}) {
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
    ...overrides,
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export let workspaceId = "";

export function registerWorkspaceSettingsSyncLifecycleHooks() {
  beforeEach(() => {
    installWorkspaceSettingsSyncMocks();
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    jsonRpcSocketInternal.reset();
    __controlSocketInternal.reset();
    __threadEventReducerInternal.reset();
    workspaceId = `ws-${crypto.randomUUID()}`;
    MockJsonRpcSocket.instances.length = 0;
    jsonRpcRequests.length = 0;
    jsonRpcActivityLog.length = 0;
    jsonRpcResponseOverrides.clear();
    transcriptBatches.length = 0;
    mockedLoadedState = { version: 2, workspaces: [], threads: [] };
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadAttachments.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.modelStreamByThread.clear();
    RUNTIME.providerStatusRefreshGeneration = 0;

    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      settingsPage: "workspaces",
      lastNonSettingsView: "chat",
      workspaces: [
        {
          id: workspaceId,
          name: "Workspace 1",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultPreferredChildModel: "gpt-5.2",
          defaultToolOutputOverflowChars: 25000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          wsProtocol: "jsonrpc",
          yolo: false,
        },
      ],
      threads: [],
      selectedWorkspaceId: workspaceId,
      pluginManagementWorkspaceId: null,
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
}

export {
  __controlSocketInternal,
  __threadEventReducerInternal,
  clearJsonRpcSocketOverride,
  createDeferred,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadSocket,
  flushAsyncWork,
  getWorkspaceJsonRpcHelperState,
  jsonRpcActivityLog,
  jsonRpcRequests,
  jsonRpcResponseOverrides,
  jsonRpcSocketInternal,
  latestRequest,
  MockJsonRpcSocket,
  makeSessionSnapshot,
  primeWorkspaceConnection,
  RUNTIME,
  requestJsonRpcControlEvent,
  requestsFor,
  seedConnectedThread,
  setControlSessionConfigResponse,
  setJsonRpcSocketOverride,
  syncMockedWorkspaceSessions,
  transcriptBatches,
  useAppStore,
};
