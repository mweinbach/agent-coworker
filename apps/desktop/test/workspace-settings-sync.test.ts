import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcResponseOverrides = new Map<string, (params?: unknown) => unknown | Promise<unknown>>();
const transcriptBatches: Array<Array<{
  ts: string;
  threadId: string;
  direction: "server" | "client";
  payload: unknown;
}>> = [];
let mockedLoadedState: any = { version: 2, workspaces: [], threads: [] };
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

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void; onNotification?: (message: any) => void }) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    const override = jsonRpcResponseOverrides.get(method);
    if (override) {
      return await override(params);
    }

    if (method === "thread/list") {
      const cwd =
        params && typeof params === "object" && typeof (params as { cwd?: unknown }).cwd === "string"
          ? (params as { cwd: string }).cwd
          : null;
      const workspaceId =
        cwd
          ? mockedLoadedState.workspaces?.find((workspace: { path?: string; id?: string }) => workspace.path === cwd)?.id ?? null
          : null;
      const threads = workspaceId
        ? (mockedLoadedState.threads ?? [])
            .filter((thread: { workspaceId?: string; sessionId?: string | null }) =>
              thread.workspaceId === workspaceId && typeof thread.sessionId === "string" && thread.sessionId.trim().length > 0,
            )
            .map((thread: {
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
            }))
        : [];
      return { threads };
    }

    if (method === "thread/read") {
      const threadId =
        params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string"
          ? (params as { threadId: string }).threadId
          : "thread-session";
      const persistedThread = (mockedLoadedState.threads ?? []).find((thread: { sessionId?: string | null }) => thread.sessionId === threadId);
      return {
        coworkSnapshot: makeSessionSnapshot(threadId, {
          title: persistedThread?.title ?? "Harness Snapshot Thread",
        }),
      };
    }

    if (method === "thread/resume") {
      const threadId =
        params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string"
          ? (params as { threadId: string }).threadId
          : "thread-session";
      const persistedThread = (mockedLoadedState.threads ?? []).find((thread: { sessionId?: string | null }) => thread.sessionId === threadId);
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
            workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: false },
            user: { path: "/tmp/.agent/mcp-servers.json", exists: false },
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
          catalog: { installations: [], sources: [], stats: { totalInstallations: 0, enabledInstallations: 0 } },
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
    this.opts.onClose?.();
  }

  notify(method: string, params?: unknown) {
    this.opts.onNotification?.({ method, params });
  }
}

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async (events: Array<{
    ts: string;
    threadId: string;
    direction: "server" | "client";
    payload: unknown;
  }>) => {
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
const { RUNTIME, ensureControlSocket, requestJsonRpcControlEvent } = await import("../src/app/store.helpers");
const { ensureWorkspaceJsonRpcSocket } = await import("../src/app/store.helpers/jsonRpcSocket");

function requestsFor(method: string) {
  return jsonRpcRequests.filter((entry) => entry.method === method);
}

function latestRequest(method: string) {
  return requestsFor(method).at(-1) ?? null;
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
  const workspaceId = useAppStore.getState().selectedWorkspaceId ?? useAppStore.getState().workspaces[0]?.id;
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

function seedConnectedThread(overrides: Partial<Record<string, unknown>> = {}) {
  const workspaceId = useAppStore.getState().selectedWorkspaceId ?? useAppStore.getState().workspaces[0]?.id;
  if (!workspaceId) {
    throw new Error("expected workspace");
  }
  const threadId = `thread-${crypto.randomUUID()}`;
  const sessionId = String(overrides.sessionId ?? `session-${crypto.randomUUID()}`);
  useAppStore.setState((state) => ({
    ...state,
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

function makeSessionSnapshot(
  sessionId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
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

describe("workspace settings sync", () => {
  let workspaceId = "";

  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    workspaceId = `ws-${crypto.randomUUID()}`;
    MockJsonRpcSocket.instances.length = 0;
    jsonRpcRequests.length = 0;
    jsonRpcResponseOverrides.clear();
    transcriptBatches.length = 0;
    mockedLoadedState = { version: 2, workspaces: [], threads: [] };
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
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

  test("init normalizes workspace defaultPreferredChildModel fallback", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-load",
          name: "Loaded",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    };

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.defaultModel).toBe("gpt-5.2");
    expect(loaded?.defaultPreferredChildModel).toBe("gpt-5.2");
  });

  test("init migrates legacy defaultSubAgentModel into defaultPreferredChildModel", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-migrate",
          name: "Legacy migration",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultSubAgentModel: "gpt-5.2-mini",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    };

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.defaultModel).toBe("gpt-5.4");
    expect(loaded?.defaultPreferredChildModel).toBe("gpt-5.2-mini");
  });

  test("init preserves workspace user profile defaults during rehydration", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-profile",
          name: "Loaded profile",
          path: "/tmp/workspace-profile",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun",
          },
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    };

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.userName).toBe("Alex");
    expect(loaded?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun",
    });
  });

  test("init preserves persisted workspace overflow defaults during rehydration", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-null",
          name: "Null overflow",
          path: "/tmp/workspace-null",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultToolOutputOverflowChars: null,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws-default",
          name: "Default overflow",
          path: "/tmp/workspace-default",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:01.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultToolOutputOverflowChars: 25000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws-missing",
          name: "Missing overflow",
          path: "/tmp/workspace-missing",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:02.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    };

    await useAppStore.getState().init();

    const workspaces = useAppStore.getState().workspaces;
    expect(workspaces.find((workspace) => workspace.id === "ws-null")?.defaultToolOutputOverflowChars).toBeNull();
    expect(workspaces.find((workspace) => workspace.id === "ws-default")?.defaultToolOutputOverflowChars).toBe(25000);
    expect(workspaces.find((workspace) => workspace.id === "ws-missing")?.defaultToolOutputOverflowChars).toBeUndefined();
  });

  test("init hydrates persisted provider status snapshots before the first refresh completes", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-load",
          name: "Loaded",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          "codex-cli": {
            provider: "codex-cli",
            authorized: true,
            verified: false,
            mode: "oauth",
            account: { email: "max@example.com" },
            message: "Codex credentials present.",
            checkedAt: "2026-02-19T00:00:00.000Z",
          },
        },
        statusLastUpdatedAt: "2026-02-19T00:00:00.000Z",
      },
    };

    await useAppStore.getState().init();

    const state = useAppStore.getState();
    expect(state.providerStatusByName["codex-cli"]?.authorized).toBe(true);
    expect(state.providerStatusByName["codex-cli"]?.mode).toBe("oauth");
    expect(state.providerStatusByName["codex-cli"]?.account?.email).toBe("max@example.com");
    expect(state.providerStatusLastUpdatedAt).toBe("2026-02-19T00:00:00.000Z");
    expect(state.providerConnected).toEqual(["codex-cli"]);
  });

  test("init reopens the latest workspace thread even when it was persisted disconnected", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-load",
          name: "Loaded",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-load",
          workspaceId: "ws-load",
          title: "Recovered thread",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastMessageAt: "2026-02-19T00:05:00.000Z",
          status: "disconnected",
          sessionId: "thread-session-persisted",
        },
      ],
      developerMode: false,
      showHiddenFiles: false,
    };

    await useAppStore.getState().init();
    await flushAsyncWork();
    await flushAsyncWork();

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-load");
    expect(state.selectedThreadId).toBe("thread-session-persisted");
    expect(RUNTIME.jsonRpcSockets.has("ws-load")).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
  });

  test("init prefers the most recently opened workspace when restoring a thread", async () => {
    mockedLoadedState = {
      version: 2,
      workspaces: [
        {
          id: "ws-old",
          name: "Older",
          path: "/tmp/workspace-old",
          createdAt: "2026-02-18T00:00:00.000Z",
          lastOpenedAt: "2026-02-18T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
        {
          id: "ws-new",
          name: "Newer",
          path: "/tmp/workspace-new",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-old",
          workspaceId: "ws-old",
          title: "Older thread",
          createdAt: "2026-02-18T00:00:00.000Z",
          lastMessageAt: "2026-02-18T00:05:00.000Z",
          status: "active",
          sessionId: "thread-session-old",
        },
        {
          id: "thread-new",
          workspaceId: "ws-new",
          title: "Newer thread",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastMessageAt: "2026-02-19T00:05:00.000Z",
          status: "disconnected",
          sessionId: "thread-session-new",
        },
      ],
      developerMode: false,
      showHiddenFiles: false,
    };

    await useAppStore.getState().init();
    await flushAsyncWork();
    await flushAsyncWork();

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-new");
    expect(state.selectedThreadId).toBe("thread-session-new");
    expect(RUNTIME.jsonRpcSockets.has("ws-new")).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
  });

  test("control session_config hydrates the workspace defaults from the harness", async () => {
    primeWorkspaceConnection();
    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: false,
      defaultBackupsEnabled: false,
      toolOutputOverflowChars: 12000,
      defaultToolOutputOverflowChars: 12000,
      preferredChildModel: "gpt-5-mini",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "opencode-zen:glm-5",
      allowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
      maxSteps: 75,
      userName: "Alex",
      userProfile: { instructions: "", work: "", details: "" },
    });

    const ok = await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.defaultPreferredChildModel).toBe("gpt-5-mini");
    expect(workspace?.defaultChildModelRoutingMode).toBe("cross-provider-allowlist");
    expect(workspace?.defaultPreferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(workspace?.defaultAllowedChildModelRefs).toEqual(["opencode-zen:glm-5", "opencode-go:glm-5"]);
    expect(workspace?.defaultBackupsEnabled).toBe(false);
    expect(workspace?.defaultToolOutputOverflowChars).toBe(12000);
    expect(workspace?.userName).toBe("Alex");
    expect(workspace?.userProfile).toEqual({ instructions: "", work: "", details: "" });
    expect(runtime?.controlSessionConfig?.preferredChildModel).toBe("gpt-5-mini");
    expect(runtime?.controlSessionConfig?.childModelRoutingMode).toBe("cross-provider-allowlist");
    expect(runtime?.controlSessionConfig?.preferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(runtime?.controlSessionConfig?.allowedChildModelRefs).toEqual(["opencode-zen:glm-5", "opencode-go:glm-5"]);
    expect(runtime?.controlSessionConfig?.backupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultBackupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultToolOutputOverflowChars).toBe(12000);
  });

  test("control session_config keeps session backup overrides separate from the workspace default", async () => {
    primeWorkspaceConnection();
    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: false,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      maxSteps: 75,
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.defaultBackupsEnabled).toBe(true);
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(runtime?.controlSessionConfig?.backupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultBackupsEnabled).toBe(true);
    expect(runtime?.controlSessionConfig?.toolOutputOverflowChars).toBe(25000);
  });

  test("control session_config replaces editable providerOptions in workspace defaults", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              providerOptions: {
                openai: {
                  reasoningEffort: "high",
                  reasoningSummary: "detailed",
                },
              },
            }
          : workspace,
      ),
    }));

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: true,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      providerOptions: {
        openai: {
          reasoningSummary: "concise",
          textVerbosity: "high",
        },
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "auto",
          webSearchBackend: "native",
          webSearchMode: "live",
        },
      },
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toEqual({
      openai: {
        reasoningSummary: "concise",
        textVerbosity: "high",
      },
      "codex-cli": {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        webSearchBackend: "native",
        webSearchMode: "live",
      },
    });
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toEqual({
      openai: {
        reasoningSummary: "concise",
        textVerbosity: "high",
      },
      "codex-cli": {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        webSearchBackend: "native",
        webSearchMode: "live",
      },
    });
  });

  test("control session_config clears stale editable providerOptions when snapshot omits them", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              providerOptions: {
                openai: {
                  reasoningEffort: "high",
                  reasoningSummary: "detailed",
                  textVerbosity: "medium",
                },
              },
            }
          : workspace,
      ),
    }));

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: true,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      maxSteps: 75,
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toBeUndefined();
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toBeUndefined();
  });

  test("updateWorkspaceDefaults syncs control defaults over the shared JsonRpcSocket", async () => {
    jsonRpcRequests.length = 0;
    setControlSessionConfigResponse({
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
      userName: "Taylor",
      userProfile: {
        instructions: "Keep answers terse.",
        work: "Platform engineer",
        details: "Prefers Bun and TypeScript",
      },
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      },
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      userName: "Taylor",
      userProfile: {
        instructions: "Keep answers terse.",
        work: "Platform engineer",
        details: "Prefers Bun and TypeScript",
      },
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.userName).toBe("Taylor");
    expect(workspace?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun and TypeScript",
    });

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        userName: "Taylor",
        userProfile: {
          instructions: "Keep answers terse.",
          work: "Platform engineer",
          details: "Prefers Bun and TypeScript",
        },
        providerOptions: {
          "codex-cli": {
            reasoningEffort: "xhigh",
            reasoningSummary: "detailed",
          },
        },
      },
    });
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  test("updateWorkspaceDefaults reports partial apply when the control request fails", async () => {
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      throw new Error("boom");
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    });

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Workspace settings partially applied");
    expect(notification?.detail).toBe("Control session is not fully connected yet. Reopen the workspace settings to retry.");
  });

  test("applyWorkspaceDefaultsToThread routes thread defaults over the shared JsonRpcSocket", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultChildModelRoutingMode: "cross-provider-allowlist",
              defaultPreferredChildModelRef: "opencode-zen:glm-5",
              defaultAllowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
              userName: "Alex",
              userProfile: {
                instructions: "Keep answers terse.",
                work: "Platform engineer",
                details: "Prefers Bun",
              },
              providerOptions: {
                openai: {
                  reasoningEffort: "high",
                  reasoningSummary: "detailed",
                  textVerbosity: "medium",
                },
              },
            }
          : workspace,
      ),
    }));
    const { threadId } = seedConnectedThread();
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        toolOutputOverflowChars: 25000,
        childModelRoutingMode: "cross-provider-allowlist",
        preferredChildModelRef: "opencode-zen:glm-5",
        allowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
        userName: "Alex",
        userProfile: {
          instructions: "Keep answers terse.",
          work: "Platform engineer",
          details: "Prefers Bun",
        },
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "detailed",
            textVerbosity: "medium",
          },
        },
      },
    });
  });

  test("applyWorkspaceDefaultsToThread preserves allowBeforeHydration when deferring for a busy thread", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          sessionConfig: null,
          enableMcp: null,
          busy: true,
        },
      },
    }));
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "auto", null, { allowBeforeHydration: true });

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId)?.allowBeforeHydration).toBe(true);
    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
  });

  test("removeWorkspace reuses the shared JsonRpcSocket for thread/unsubscribe before closing it", async () => {
    primeWorkspaceConnection();
    ensureWorkspaceJsonRpcSocket(useAppStore.getState, useAppStore.setState, workspaceId);
    const { threadId, sessionId } = seedConnectedThread();
    jsonRpcRequests.length = 0;
    const socketsBefore = MockJsonRpcSocket.instances.length;
    expect(socketsBefore).toBeGreaterThan(0);

    await useAppStore.getState().removeWorkspace(workspaceId);
    await flushAsyncWork();

    expect(MockJsonRpcSocket.instances.length).toBe(socketsBefore);
    expect(requestsFor("thread/unsubscribe")).toEqual([
      expect.objectContaining({
        method: "thread/unsubscribe",
        params: { threadId: sessionId },
      }),
    ]);
    expect(useAppStore.getState().workspaces.some((w) => w.id === workspaceId)).toBe(false);
    expect(useAppStore.getState().threads.some((t) => t.id === threadId)).toBe(false);
  });

  test("removeWorkspace closes the shared JsonRpcSocket before removing it so install waiters reject", async () => {
    primeWorkspaceConnection();
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);

    const rejected = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:project",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    await Promise.all([
      useAppStore.getState().removeWorkspace(workspaceId),
      expect(rejected.promise).rejects.toThrow("Control connection closed"),
    ]);

    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
  });

  test("applyWorkspaceDefaultsToThread defers auto apply until session settings hydrate", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    const hydratedRuntime = useAppStore.getState().threadRuntimeById[threadId];
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultEnableMcp: false,
            }
          : workspace,
      ),
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          sessionConfig: null,
          enableMcp: null,
        },
      },
    }));
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "auto");

    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId)).toEqual({
      mode: "auto",
      draftModelSelection: null,
      inFlight: false,
    });

    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          sessionConfig: hydratedRuntime?.sessionConfig ?? null,
          enableMcp: hydratedRuntime?.enableMcp ?? true,
        },
      },
    }));

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "auto");

    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(1);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(threadId)).toBe(false);
  });

  test("applyWorkspaceDefaultsToThread flushes the oldest queued message after defaults apply", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    RUNTIME.pendingThreadMessages.set(threadId, ["first queued", "second queued"]);
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    expect(requestsFor("turn/start")).toHaveLength(1);
    expect(latestRequest("turn/start")?.params).toMatchObject({
      threadId: sessionId,
      input: [{ type: "text", text: "first queued" }],
    });
    expect(RUNTIME.pendingThreadMessages.get(threadId)).toEqual(["second queued"]);
  });

  test("applyWorkspaceDefaultsToThread does not persist a transcript entry when the request fails", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      throw new Error("boom");
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    transcriptBatches.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushAsyncWork();

    const appliedDefaultsEntries = transcriptBatches
      .flat()
      .filter((entry) =>
        entry.direction === "client"
        && typeof entry.payload === "object"
        && entry.payload !== null
        && (entry.payload as { type?: unknown }).type === "apply_session_defaults");
    expect(appliedDefaultsEntries).toHaveLength(0);
    expect(useAppStore.getState().notifications.at(-1)?.detail).toBe(
      "Unable to apply workspace defaults to the active thread.",
    );
  });

  test("applyWorkspaceDefaultsToThread preserves a baseten workspace provider", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "baseten",
              defaultModel: "moonshotai/Kimi-K2.5",
              defaultPreferredChildModel: "moonshotai/Kimi-K2.5",
            }
          : workspace,
      ),
    }));
    const { threadId } = seedConnectedThread();
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
    });
  });

  test("updateWorkspaceDefaults clears the persisted overflow override on the control session", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultToolOutputOverflowChars: 12000,
            }
          : workspace,
      ),
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlSessionConfig: {
            defaultToolOutputOverflowChars: 12000,
          },
          controlEnableMcp: true,
        },
      },
    }));
    seedConnectedThread({
      sessionConfig: {
        defaultToolOutputOverflowChars: 12000,
      },
    });
    setControlSessionConfigResponse({
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
      clearToolOutputOverflowChars: true,
    });
    jsonRpcResponseOverrides.set("cowork/session/state/read", async () => ({
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
            defaultToolOutputOverflowChars: 12000,
            enableMemory: true,
            memoryRequireApproval: false,
            preferredChildModel: "gpt-5.2",
            childModelRoutingMode: "same-provider",
            preferredChildModelRef: "openai:gpt-5.2",
            allowedChildModelRefs: [],
            maxSteps: 100,
          },
        },
      ],
    }));
    jsonRpcRequests.length = 0;

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      clearDefaultToolOutputOverflowChars: true,
    });
    await flushAsyncWork();

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(1);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        clearToolOutputOverflowChars: true,
      },
    });
  });

  test("updateWorkspaceDefaults keeps control runtime in sync after a workspace control apply", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlConfig: {
            provider: "google",
            model: "gemini-3-pro",
            workingDirectory: "/tmp/workspace",
          },
          controlSessionConfig: {
            defaultBackupsEnabled: true,
          },
          controlEnableMcp: true,
        },
      },
    }));
    setControlSessionConfigResponse({
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
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultProvider: "openai",
      defaultModel: "gpt-5.2",
      defaultEnableMcp: false,
    });

    const runtimeAfterFirstApply = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtimeAfterFirstApply?.controlConfig).toEqual({
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
    });
    expect(runtimeAfterFirstApply?.controlEnableMcp).toBe(false);

    jsonRpcRequests.length = 0;
    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {});

    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
  });
});
