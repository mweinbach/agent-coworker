import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  client: string;
  onEvent?: (evt: any) => void;
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

  close() {}

  emit(evt: any) {
    this.opts.onEvent?.(evt);
  }
}

const MOCK_SOCKETS: MockAgentSocket[] = [];

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async () => {},
  startWorkspaceServer: async () => ({ url: "ws://mock" }),
  stopWorkspaceServer: async () => {},
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

describe("workspace MCP editor flow", () => {
  let workspaceId = "";

  beforeEach(() => {
    workspaceId = `ws-${crypto.randomUUID()}`;
    MOCK_SOCKETS.length = 0;

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

  test("requests MCP servers on control connect and hydrates runtime from mcp_servers", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    const sentTypes = controlSocket.sent.map((message) => message?.type).filter(Boolean);
    expect(sentTypes).toContain("mcp_servers_get");

    controlSocket.emit({
      type: "mcp_servers",
      sessionId: "control-session",
      servers: [
        {
          name: "grep",
          transport: { type: "http", url: "https://mcp.grep.app" },
          source: "workspace",
          inherited: false,
          authMode: "missing",
          authScope: "workspace",
          authMessage: "OAuth required.",
        },
      ],
      legacy: {
        workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: true },
        user: { path: "/tmp/home/.agent/mcp-servers.json", exists: false },
      },
      files: [
        {
          source: "workspace",
          path: "/tmp/workspace/.cowork/mcp-servers.json",
          exists: true,
          editable: true,
          legacy: false,
          serverCount: 1,
        },
      ],
      warnings: ["workspace_legacy: invalid JSON"],
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.mcpServers).toHaveLength(1);
    expect(runtime?.mcpServers[0]?.name).toBe("grep");
    expect(runtime?.mcpFiles[0]?.path).toBe("/tmp/workspace/.cowork/mcp-servers.json");
    expect(runtime?.mcpWarnings[0]).toContain("invalid JSON");
  });

  test("upsertWorkspaceMcpServer sends mcp_server_upsert and accepts refreshed snapshot", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().upsertWorkspaceMcpServer(workspaceId, {
      name: "local",
      transport: { type: "stdio", command: "echo", args: ["ok"] },
      auth: { type: "none" },
    });

    const sentSet = controlSocket.sent.find((message) => message?.type === "mcp_server_upsert");
    expect(sentSet).toBeDefined();
    expect(sentSet?.server?.name).toBe("local");

    controlSocket.emit({
      type: "mcp_servers",
      sessionId: "control-session",
      servers: [
        {
          name: "local",
          transport: { type: "stdio", command: "echo", args: ["ok"] },
          auth: { type: "none" },
          source: "workspace",
          inherited: false,
          authMode: "none",
          authScope: "workspace",
          authMessage: "No authentication required.",
        },
      ],
      legacy: {
        workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: false },
        user: { path: "/tmp/home/.agent/mcp-servers.json", exists: false },
      },
      files: [],
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.mcpServers[0]?.name).toBe("local");
  });

  test("requestWorkspaceMcpServers sends mcp_servers_get", async () => {
    await useAppStore.getState().newThread({ workspaceId });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().requestWorkspaceMcpServers(workspaceId);

    const sent = controlSocket.sent.find((message) => message?.type === "mcp_servers_get");
    expect(sent).toBeDefined();
  });
});
