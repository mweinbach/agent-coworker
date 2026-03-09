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
    RUNTIME.pendingWorkspaceDefaultApplyThreadIds.clear();
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
          defaultSubAgentModel: "gpt-5.2",
          defaultEnableMcp: true,
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

  test("init normalizes workspace defaultSubAgentModel fallback", async () => {
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
    };

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.defaultModel).toBe("gpt-5.2");
    expect(loaded?.defaultSubAgentModel).toBe("gpt-5.2");
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

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-load");
    expect(state.selectedThreadId).toBe("thread-load");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    expect(controlSocket.opts.autoReconnect).toBe(true);
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

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-new");
    expect(state.selectedThreadId).toBe("thread-new");

    const threadSocket = socketByClient("desktop");
    expect(threadSocket.opts.resumeSessionId).toBe("thread-session-new");
  });

  test("control session_config syncs workspace default subagent model", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        subAgentModel: "gpt-5-mini",
        maxSteps: 75,
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.defaultSubAgentModel).toBe("gpt-5-mini");
    expect(runtime?.controlSessionConfig?.subAgentModel).toBe("gpt-5-mini");
  });

  test("control session_config replaces editable providerOptions in workspace defaults", async () => {
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
                "codex-cli": {
                  reasoningEffort: "low",
                  reasoningSummary: "auto",
                },
              },
            }
          : workspace,
      ),
    }));

    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        subAgentModel: "gpt-5.4-mini",
        providerOptions: {
          openai: {
            reasoningSummary: "concise",
            textVerbosity: "high",
          },
          "codex-cli": {
            reasoningEffort: "xhigh",
            reasoningSummary: "auto",
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

    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "session_config",
      sessionId: "control-session",
      config: {
        yolo: false,
        observabilityEnabled: true,
        subAgentModel: "gpt-5.4-mini",
        maxSteps: 75,
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toBeUndefined();
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toBeUndefined();
  });

  test("applyWorkspaceDefaultsToThread sends model, session config, and mcp toggle", async () => {
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
                "codex-cli": {
                  reasoningEffort: "medium",
                  reasoningSummary: "auto",
                },
              },
            }
          : workspace,
      ),
    }));

    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];

    const threadId = useAppStore.getState().threads[0]?.id;
    if (!threadId) throw new Error("expected thread");
    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    const sentTypes = threadSocket.sent.map((message) => message?.type);
    expect(sentTypes).toEqual(["set_model", "set_config", "set_enable_mcp"]);
    expect(threadSocket.sent[1]).toMatchObject({
      type: "set_config",
      config: {
        subAgentModel: "gpt-5.2",
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

    await useAppStore.getState().newThread({ workspaceId });
    await useAppStore.getState().newThread({ workspaceId });

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
      defaultSubAgentModel: "gpt-5.2-mini",
      defaultEnableMcp: false,
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

    const controlSent = controlSocket.sent.map((message) => message?.type);
    expect(controlSent).toContain("set_model");
    expect(controlSent).toContain("set_config");
    expect(controlSent).toContain("set_enable_mcp");
    expect(controlSocket.sent.find((message) => message?.type === "set_config")).toMatchObject({
      type: "set_config",
      config: {
        subAgentModel: "gpt-5.2-mini",
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

    expect(idleThreadSocket.sent.map((message) => message?.type)).toEqual([
      "set_model",
      "set_config",
      "set_enable_mcp",
    ]);
    expect(idleThreadSocket.sent.find((message) => message?.type === "set_config")).toMatchObject({
      type: "set_config",
      config: {
        subAgentModel: "gpt-5.2-mini",
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

    busyThreadSocket.emit({
      type: "session_busy",
      sessionId: "thread-busy",
      busy: false,
    });

    expect(busyThreadSocket.sent.map((message) => message?.type)).toEqual([
      "set_model",
      "set_config",
      "set_enable_mcp",
    ]);
    expect(busyThreadSocket.sent.find((message) => message?.type === "set_config")).toMatchObject({
      type: "set_config",
      config: {
        subAgentModel: "gpt-5.2-mini",
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
