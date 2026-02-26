import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  client: string;
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
  openPath: async () => {},
  revealPath: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  renamePath: async () => {},
  trashPath: async () => {},
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: MockAgentSocket,
}));

const { useAppStore } = await import("../src/app/store");

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

  test("applyWorkspaceDefaultsToThread sends model, session config, and mcp toggle", async () => {
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
  });

  test("updateWorkspaceDefaults applies to all live threads and retries queued busy thread", async () => {
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
    });

    const controlSent = controlSocket.sent.map((message) => message?.type);
    expect(controlSent).toContain("set_model");
    expect(controlSent).toContain("set_config");
    expect(controlSent).toContain("set_enable_mcp");

    expect(idleThreadSocket.sent.map((message) => message?.type)).toEqual([
      "set_model",
      "set_config",
      "set_enable_mcp",
    ]);
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
  });
});
