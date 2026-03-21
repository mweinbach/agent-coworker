import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  client: string;
  autoReconnect?: boolean;
  resumeSessionId?: string;
  onEvent?: (evt: any) => void;
  onClose?: (reason: string) => void;
};

class MockAgentSocket {
  sent: any[] = [];

  constructor(public readonly opts: MockSocketOpts) {
    MOCK_SOCKETS.push(this);
  }

  connect() {}

  send(message?: any) {
    this.sent.push(message);
    return true;
  }

  close() {
    this.opts.onClose?.("closed");
  }

  emit(evt: any) {
    this.opts.onEvent?.(evt);
  }
}

const MOCK_SOCKETS: MockAgentSocket[] = [];
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

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
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
  AgentSocket: MockAgentSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME } = await import("../src/app/store.helpers");

function socketByClient(client: string): MockAgentSocket {
  const socket = [...MOCK_SOCKETS].reverse().find((entry) => entry.opts.client === client);
  if (!socket) throw new Error(`Missing mock socket for client=${client}`);
  return socket;
}

function socketsByClient(client: string): MockAgentSocket[] {
  return MOCK_SOCKETS.filter((entry) => entry.opts.client === client);
}

function emitServerHello(socket: MockAgentSocket, sessionId: string) {
  socket.emit({
    type: "server_hello",
    sessionId,
    protocolVersion: "6.0",
    config: {
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/workspace/output",
    },
  });
}

function emitThreadSessionDefaults(
  socket: MockAgentSocket,
  sessionId: string,
  overrides: {
    settings?: Partial<Record<string, unknown>>;
    config?: Partial<Record<string, unknown>>;
  } = {},
) {
  socket.emit({
    type: "session_settings",
    sessionId,
    enableMcp: true,
    enableMemory: true,
    memoryRequireApproval: false,
    ...(overrides.settings ?? {}),
  });
  socket.emit({
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
      ...(overrides.config ?? {}),
    },
  });
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
    workspaceId = `ws-${crypto.randomUUID()}`;
    MOCK_SOCKETS.length = 0;
    mockedLoadedState = { version: 2, workspaces: [], threads: [] };
    RUNTIME.controlSockets.clear();
    RUNTIME.threadSockets.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.modelStreamByThread.clear();

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

    const controlSocket = socketByClient("desktop-control");
    expect(controlSocket.opts.autoReconnect).toBe(true);
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: "thread-session-persisted",
    });
    controlSocket.emit({
      type: "session_snapshot",
      sessionId: "control-session",
      targetSessionId: "thread-session-persisted",
      snapshot: makeSessionSnapshot("thread-session-persisted"),
    });
    await flushAsyncWork();

    const threadSocket = socketByClient("desktop");
    expect(threadSocket.opts.autoReconnect).toBe(true);
    expect(threadSocket.opts.resumeSessionId).toBe("thread-session-persisted");
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

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: "thread-session-new",
    });
    controlSocket.emit({
      type: "session_snapshot",
      sessionId: "control-session",
      targetSessionId: "thread-session-new",
      snapshot: makeSessionSnapshot("thread-session-new"),
    });
    await flushAsyncWork();

    const threadSocket = socketByClient("desktop");
    expect(threadSocket.opts.resumeSessionId).toBe("thread-session-new");
  });

  test("control session_config hydrates the workspace defaults from the harness", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
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
      },
    });

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
    expect(runtime?.controlSessionConfig?.toolOutputOverflowChars).toBe(12000);
    expect((runtime?.controlSessionConfig as any)?.userName).toBe("Alex");
    expect((runtime?.controlSessionConfig as any)?.userProfile).toEqual({ instructions: "", work: "", details: "" });
  });

  test("control session_config keeps session backup overrides separate from the workspace default", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        backupsEnabled: false,
        defaultBackupsEnabled: true,
        toolOutputOverflowChars: 25000,
        preferredChildModel: "gpt-5-mini",
        maxSteps: 75,
        userName: "Alex",
        userProfile: { instructions: "", work: "", details: "" },
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.defaultBackupsEnabled).toBe(true);
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(runtime?.controlSessionConfig?.backupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultBackupsEnabled).toBe(true);
    expect(runtime?.controlSessionConfig?.toolOutputOverflowChars).toBe(25000);
  });

  test("control session_config replaces editable providerOptions in workspace defaults", async () => {
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
                },
                "codex-cli": {
                  reasoningEffort: "low",
                  reasoningSummary: "auto",
                  webSearchBackend: "exa",
                  webSearchMode: "disabled",
                },
              },
            }
          : workspace,
      ),
    }));

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
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
            webSearch: {
              contextSize: "medium",
              allowedDomains: ["openai.com"],
              location: {
                country: "US",
                timezone: "America/New_York",
              },
            },
          },
        },
      },
    });

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
        webSearch: {
          contextSize: "medium",
          allowedDomains: ["openai.com"],
          location: {
            country: "US",
            timezone: "America/New_York",
          },
        },
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
        webSearch: {
          contextSize: "medium",
          allowedDomains: ["openai.com"],
          location: {
            country: "US",
            timezone: "America/New_York",
          },
        },
      },
    });
  });

  test("control session_config clears stale editable providerOptions when snapshot omits them", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
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

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        backupsEnabled: true,
        defaultBackupsEnabled: true,
        toolOutputOverflowChars: 25000,
        preferredChildModel: "gpt-5-mini",
        maxSteps: 75,
        userName: "Alex",
        userProfile: { instructions: "", work: "", details: "" },
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toBeUndefined();
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toBeUndefined();
  });

  test("updateWorkspaceDefaults waits for the initial control hello before warning about partial apply", async () => {
    const updatePromise = useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      },
    });

    await flushAsyncWork();
    const controlSocket = socketByClient("desktop-control");

    expect(controlSocket.sent.filter((msg) => msg?.type === "apply_session_defaults")).toHaveLength(0);
    expect(useAppStore.getState().notifications).toHaveLength(0);

    emitServerHello(controlSocket, "control-session");
    await updatePromise;

    const applyDefaultsMessages = controlSocket.sent.filter((msg) => msg?.type === "apply_session_defaults");
    expect(applyDefaultsMessages).toHaveLength(1);
    expect(applyDefaultsMessages[0]).toMatchObject({
      type: "apply_session_defaults",
      enableMcp: true,
      config: {
        backupsEnabled: true,
        preferredChildModel: "gpt-5.2",
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

  test("updateWorkspaceDefaults reports partial apply when the initial control connection closes before hello", async () => {
    const updatePromise = useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    });

    await flushAsyncWork();
    const controlSocket = socketByClient("desktop-control");
    controlSocket.close();
    await updatePromise;

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Workspace settings partially applied");
    expect(notification?.detail).toBe("Control session is not fully connected yet. Reopen the workspace settings to retry.");
  });

  test("applyWorkspaceDefaultsToThread sends model, session config, and mcp toggle", async () => {
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
                "codex-cli": {
                  reasoningEffort: "medium",
                  reasoningSummary: "auto",
                },
              },
            }
          : workspace,
      ),
    }));

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    emitThreadSessionDefaults(threadSocket, "thread-session");
    threadSocket.sent = [];

    const threadId = useAppStore.getState().threads[0]?.id;
    if (!threadId) throw new Error("expected thread");
    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(threadSocket.sent).toHaveLength(1);
    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
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
          "codex-cli": {
            reasoningEffort: "medium",
            reasoningSummary: "auto",
          },
        },
      },
    });
    expect((threadSocket.sent[0] as any).config?.preferredChildModel).toBeUndefined();
  });

  test("applyWorkspaceDefaultsToThread preserves an existing baseten workspace provider", async () => {
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

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    emitThreadSessionDefaults(threadSocket, "thread-session");
    threadSocket.sent = [];

    const threadId = useAppStore.getState().threads[0]?.id;
    if (!threadId) throw new Error("expected thread");
    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
    });
  });

  test("updateWorkspaceDefaults syncs baseten control-session defaults without rewriting the provider", async () => {
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

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");

    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultModel: "moonshotai/Kimi-K2.5",
    });

    expect(controlSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "control-session",
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
    });
  });

  test("thread connect does not replay a stale local backup default before the harness sync arrives", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");

    threadSocket.sent = [];
    emitServerHello(threadSocket, "thread-session");

    expect(
      threadSocket.sent.some((message) => message?.type === "set_config" && "backupsEnabled" in (message?.config ?? {})),
    ).toBe(false);
  });

  test("thread connect only replays explicit harness overflow defaults after control-session hydration", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        backupsEnabled: false,
        defaultBackupsEnabled: false,
        toolOutputOverflowChars: 25000,
        preferredChildModel: "gpt-5.2",
        maxSteps: 75,
        userName: "Alex",
        userProfile: { instructions: "", work: "", details: "" },
      },
    });

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];
    emitThreadSessionDefaults(threadSocket, "thread-session", {
      config: {
        backupsEnabled: false,
        defaultBackupsEnabled: true,
      },
    });

    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      config: {
        backupsEnabled: false,
      },
    });
    expect(threadSocket.sent[0]?.config?.toolOutputOverflowChars).toBeUndefined();
  });

  test("thread connect replays the explicit harness overflow default when one is configured", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        backupsEnabled: false,
        defaultBackupsEnabled: false,
        toolOutputOverflowChars: 12000,
        defaultToolOutputOverflowChars: 12000,
        preferredChildModel: "gpt-5.2",
        maxSteps: 75,
        userName: "Alex",
        userProfile: { instructions: "", work: "", details: "" },
      },
    });

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];
    emitThreadSessionDefaults(threadSocket, "thread-session", {
      config: {
        backupsEnabled: false,
        defaultBackupsEnabled: true,
      },
    });

    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      config: {
        backupsEnabled: false,
        toolOutputOverflowChars: 12000,
      },
    });
  });

  test("updateWorkspaceDefaults merges user profile fields and syncs control plus live threads", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              userName: "Alex",
              userProfile: {
                instructions: "Keep answers terse.",
                work: "Platform engineer",
                details: "Prefers Bun",
              },
            }
          : workspace,
      ),
    }));

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");

    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      userName: "Taylor",
      userProfile: {
        details: "Prefers Bun and TypeScript",
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.userName).toBe("Taylor");
    expect(workspace?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun and TypeScript",
    });

    expect(controlSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "control-session",
      enableMcp: true,
      config: {
        backupsEnabled: true,
        toolOutputOverflowChars: 25000,
        preferredChildModel: "gpt-5.2",
        userName: "Taylor",
        userProfile: {
          instructions: "Keep answers terse.",
          work: "Platform engineer",
          details: "Prefers Bun and TypeScript",
        },
      },
    });

    expect(threadSocket.sent).toHaveLength(1);
    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      enableMcp: true,
      config: {
        backupsEnabled: true,
        toolOutputOverflowChars: 25000,
        preferredChildModel: "gpt-5.2",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5.2",
        userName: "Taylor",
        userProfile: {
          instructions: "Keep answers terse.",
          work: "Platform engineer",
          details: "Prefers Bun and TypeScript",
        },
      },
    });
  });

  test("updateWorkspaceDefaults clears the persisted overflow override and tells live threads to inherit again", async () => {
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
    }));

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        backupsEnabled: true,
        defaultBackupsEnabled: true,
        toolOutputOverflowChars: 12000,
        defaultToolOutputOverflowChars: 12000,
        preferredChildModel: "gpt-5.2",
        maxSteps: 75,
        userName: "Alex",
        userProfile: { instructions: "", work: "", details: "" },
      },
    });

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.emit({
      type: "session_config",
      sessionId: "thread-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        backupsEnabled: true,
        defaultBackupsEnabled: true,
        toolOutputOverflowChars: 12000,
        defaultToolOutputOverflowChars: 12000,
        preferredChildModel: "gpt-5.2",
        maxSteps: 75,
        userName: "Alex",
        userProfile: { instructions: "", work: "", details: "" },
      },
    });

    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      clearDefaultToolOutputOverflowChars: true,
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();

    expect(controlSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "control-session",
      enableMcp: true,
      config: {
        clearToolOutputOverflowChars: true,
      },
    });
    expect(controlSocket.sent[0]?.config?.toolOutputOverflowChars).toBeUndefined();

    expect(threadSocket.sent).toHaveLength(1);
    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      enableMcp: true,
      config: {
        clearToolOutputOverflowChars: true,
      },
    });
    expect(threadSocket.sent[0]?.config?.toolOutputOverflowChars).toBeUndefined();
  });

  test("updateWorkspaceDefaults applies to all live threads and retries queued busy thread", async () => {
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

    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const [busyThreadSocket, idleThreadSocket] = socketsByClient("desktop");
    emitServerHello(busyThreadSocket, "thread-busy");
    emitServerHello(idleThreadSocket, "thread-idle");

    busyThreadSocket.emit({
      type: "session_busy",
      sessionId: "thread-busy",
      busy: true,
    });

    controlSocket.sent = [];
    busyThreadSocket.sent = [];
    idleThreadSocket.sent = [];

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultProvider: "openai",
      defaultModel: "gpt-5.2",
      defaultPreferredChildModel: "gpt-5.2-mini",
      defaultToolOutputOverflowChars: 12000,
      defaultEnableMcp: false,
      defaultBackupsEnabled: false,
      providerOptions: {
        openai: {
          reasoningSummary: "concise",
          textVerbosity: "high",
        },
        "codex-cli": {
          reasoningEffort: "low",
          reasoningSummary: "auto",
        },
      },
    });

    expect(controlSocket.sent).toHaveLength(1);
    expect(controlSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "control-session",
      enableMcp: false,
      config: {
        backupsEnabled: false,
        preferredChildModel: "gpt-5.2-mini",
        toolOutputOverflowChars: 12000,
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "concise",
            textVerbosity: "high",
          },
          "codex-cli": {
            reasoningEffort: "low",
            reasoningSummary: "auto",
          },
        },
      },
    });

    expect(idleThreadSocket.sent).toHaveLength(1);
    expect(idleThreadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-idle",
      enableMcp: false,
      config: {
        backupsEnabled: false,
        preferredChildModel: "gpt-5.2-mini",
        toolOutputOverflowChars: 12000,
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "concise",
            textVerbosity: "high",
          },
          "codex-cli": {
            reasoningEffort: "low",
            reasoningSummary: "auto",
          },
        },
      },
    });
    expect(busyThreadSocket.sent).toHaveLength(0);

    busyThreadSocket.sent = [];
    busyThreadSocket.emit({
      type: "session_busy",
      sessionId: "thread-busy",
      busy: false,
    });

    expect(busyThreadSocket.sent).toHaveLength(1);
    expect(busyThreadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-busy",
      enableMcp: false,
      config: {
        backupsEnabled: false,
        preferredChildModel: "gpt-5.2-mini",
        toolOutputOverflowChars: 12000,
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "concise",
            textVerbosity: "high",
          },
          "codex-cli": {
            reasoningEffort: "low",
            reasoningSummary: "auto",
          },
        },
      },
    });
  });
});
