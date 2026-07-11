import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: unknown) => unknown | Promise<unknown>>();

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

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void }) {
    MockJsonRpcSocket.instances.push(this);
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    const handler = jsonRpcHandlers.get(method);
    if (!handler) {
      return {};
    }
    return await handler(params);
  }

  respond() {
    return true;
  }

  close() {
    this.opts.onClose?.();
  }
}

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
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

const { useAppStore } = await import("../src/app/store");
const { createWorkspaceMcpActions } = await import("../src/app/store.actions/mcp");
const { defaultWorkspaceRuntime, RUNTIME } = await import("../src/app/store.helpers");

function setDefaultHandlers(workspacePath = "/tmp/workspace") {
  jsonRpcHandlers.set("thread/list", async () => ({ threads: [] }));
  jsonRpcHandlers.set("cowork/provider/catalog/read", async () => ({
    event: {
      type: "provider_catalog",
      sessionId: "jsonrpc-control",
      all: [],
      default: {},
      connected: [],
    },
  }));
  jsonRpcHandlers.set("cowork/provider/authMethods/read", async () => ({
    event: { type: "provider_auth_methods", sessionId: "jsonrpc-control", methods: {} },
  }));
  jsonRpcHandlers.set("cowork/provider/status/refresh", async () => ({
    event: { type: "provider_status", sessionId: "jsonrpc-control", providers: [] },
  }));
  jsonRpcHandlers.set("cowork/memory/list", async () => ({
    event: { type: "memory_list", sessionId: "jsonrpc-control", memories: [] },
  }));
  jsonRpcHandlers.set("cowork/skills/catalog/read", async () => ({
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
  }));
  jsonRpcHandlers.set("cowork/skills/list", async () => ({
    event: { type: "skills_list", sessionId: "jsonrpc-control", skills: [] },
  }));
  jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({
    event: {
      type: "mcp_servers",
      sessionId: "jsonrpc-control",
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
        {
          name: "figma-mcp",
          transport: { type: "stdio", command: "figma-mcp" },
          source: "plugin",
          inherited: false,
          pluginId: "plugin-1",
          pluginName: "figma-toolkit",
          pluginDisplayName: "Figma Toolkit",
          pluginScope: "workspace",
          authMode: "none",
          authScope: "workspace",
          authMessage: "",
        },
      ],
      files: [
        {
          source: "workspace",
          path: `${workspacePath}/.cowork/mcp-servers.json`,
          exists: true,
          editable: true,
          legacy: false,
          serverCount: 1,
        },
        {
          source: "plugin",
          path: `${workspacePath}/.agents/plugins/figma-toolkit/.mcp.json`,
          exists: true,
          editable: false,
          legacy: false,
          pluginId: "plugin-1",
          pluginName: "figma-toolkit",
          pluginDisplayName: "Figma Toolkit",
          pluginScope: "workspace",
          serverCount: 1,
        },
      ],
      warnings: ["workspace: invalid JSON"],
    },
  }));
}

describe("workspace MCP editor flow", () => {
  let workspaceId = "";

  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    workspaceId = `ws-${crypto.randomUUID()}`;
    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceServerRestartAttempts.clear();
    setDefaultHandlers();
    const workspaceMcpActions = createWorkspaceMcpActions(
      useAppStore.setState,
      useAppStore.getState,
    );

    act(() => {
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
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
        ],
        threads: [],
        selectedWorkspaceId: workspaceId,
        selectedThreadId: null,
        workspaceRuntimeById: {
          [workspaceId]: {
            ...defaultWorkspaceRuntime(),
            serverUrl: "ws://mock",
          },
        },
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
        composerDraftsByKey: {},
        injectContext: false,
        developerMode: false,
        showHiddenFiles: false,
        sidebarCollapsed: false,
        contextSidebarCollapsed: false,
        contextSidebarWidth: 300,
        messageBarHeight: 120,
        sidebarWidth: 280,
        ...workspaceMcpActions,
      } as any);
    });
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
  });

  test("requestWorkspaceMcpServers hydrates runtime from the shared JsonRpcSocket", async () => {
    await useAppStore.getState().requestWorkspaceMcpServers(workspaceId);

    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("cowork/mcp/servers/read");

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.mcpServers).toHaveLength(2);
    expect(runtime?.mcpServers[0]?.name).toBe("grep");
    expect(runtime?.mcpServers[1]).toMatchObject({
      name: "figma-mcp",
      source: "plugin",
      pluginDisplayName: "Figma Toolkit",
    });
    expect(runtime?.mcpFiles[0]?.path).toBe("/tmp/workspace/.cowork/mcp-servers.json");
    expect(runtime?.mcpFiles[1]).toMatchObject({
      source: "plugin",
      path: "/tmp/workspace/.agents/plugins/figma-toolkit/.mcp.json",
      editable: false,
      pluginDisplayName: "Figma Toolkit",
    });
    expect(runtime?.mcpWarnings[0]).toContain("invalid JSON");
  });

  test("upsertWorkspaceMcpServer can target global user MCP config", async () => {
    jsonRpcHandlers.set("cowork/mcp/server/upsert", async (params) => ({
      event: {
        type: "mcp_servers",
        sessionId: "jsonrpc-control",
        servers: [
          {
            name: "local",
            transport: { type: "stdio", command: "echo", args: ["ok"] },
            source: "user",
            inherited: true,
            authMode: "none",
            authScope: "user",
            authMessage: null,
          },
        ],
        legacy: {
          workspace: { path: "/tmp/workspace/.cowork/mcp-servers.json", exists: false },
          user: { path: "/tmp/home/.cowork/mcp-servers.json", exists: false },
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
        warnings: [],
        received: params,
      },
    }));

    const result = await useAppStore.getState().upsertWorkspaceMcpServer(
      workspaceId,
      {
        name: "local",
        transport: { type: "stdio", command: "echo", args: ["ok"] },
        auth: { type: "none" },
      },
      undefined,
      "user",
    );

    expect(result).toMatchObject({ ok: true });
    const request = jsonRpcRequests.find((entry) => entry.method === "cowork/mcp/server/upsert");
    expect(request?.params).toMatchObject({
      cwd: "/tmp/workspace",
      source: "user",
      server: {
        name: "local",
      },
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.mcpServers).toHaveLength(1);
    expect(runtime?.mcpServers[0]?.name).toBe("local");
  });

  test("upsertWorkspaceMcpServer returns the server failure for an editor to retain its draft", async () => {
    jsonRpcHandlers.set("cowork/mcp/server/upsert", async () => {
      throw new Error("Connector file is read-only.");
    });

    const result = await useAppStore.getState().upsertWorkspaceMcpServer(
      workspaceId,
      {
        name: "local",
        transport: { type: "stdio", command: "echo", args: ["ok"] },
        auth: { type: "none" },
      },
      undefined,
      "user",
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "Connector file is read-only.",
        retryable: true,
      },
    });
    expect(useAppStore.getState().operationsByKey[`mcp:save:${workspaceId}`]).toMatchObject({
      status: "error",
      error: { message: "Connector file is read-only." },
    });
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      title: "Connector not saved",
      audience: "foreground",
    });
  });

  test("setWorkspaceMcpServerEnabled sends source metadata and applies the returned snapshot", async () => {
    jsonRpcHandlers.set("cowork/mcp/server/setEnabled", async (params) => ({
      event: {
        type: "mcp_servers",
        sessionId: "jsonrpc-control",
        servers: [
          {
            name: "figma-mcp",
            transport: { type: "stdio", command: "figma-mcp" },
            enabled: false,
            source: "plugin",
            inherited: false,
            pluginId: "plugin-1",
            pluginName: "figma-toolkit",
            pluginDisplayName: "Figma Toolkit",
            pluginScope: "workspace",
            authMode: "none",
            authScope: "workspace",
            authMessage: "",
          },
        ],
        files: [],
        warnings: [],
        received: params,
      },
    }));

    await useAppStore.getState().setWorkspaceMcpServerEnabled(workspaceId, {
      name: "figma-mcp",
      source: "plugin",
      enabled: false,
      pluginId: "plugin-1",
      pluginScope: "workspace",
    });

    const request = jsonRpcRequests.find(
      (entry) => entry.method === "cowork/mcp/server/setEnabled",
    );
    expect(request?.params).toMatchObject({
      cwd: "/tmp/workspace",
      name: "figma-mcp",
      source: "plugin",
      enabled: false,
      pluginId: "plugin-1",
      pluginScope: "workspace",
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.mcpServers[0]).toMatchObject({
      name: "figma-mcp",
      enabled: false,
    });
  });

  test("setWorkspaceMcpServerEnabled rolls back and returns the server failure", async () => {
    act(() => {
      useAppStore.setState((state) => ({
        workspaceRuntimeById: {
          ...state.workspaceRuntimeById,
          [workspaceId]: {
            ...state.workspaceRuntimeById[workspaceId],
            mcpServers: [
              {
                name: "figma-mcp",
                transport: { type: "stdio", command: "figma-mcp" },
                enabled: true,
                source: "plugin",
                inherited: false,
                pluginId: "plugin-1",
                pluginName: "figma-toolkit",
                pluginDisplayName: "Figma Toolkit",
                pluginScope: "workspace",
                authMode: "none",
                authScope: "workspace",
                authMessage: "",
              },
            ],
          },
        },
      }));
    });
    jsonRpcHandlers.set("cowork/mcp/server/setEnabled", async () => {
      throw new Error("Connector policy rejected the update.");
    });

    const result = await useAppStore.getState().setWorkspaceMcpServerEnabled(workspaceId, {
      name: "figma-mcp",
      source: "plugin",
      enabled: false,
      pluginId: "plugin-1",
      pluginScope: "workspace",
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "Connector policy rejected the update.",
      },
    });
    expect(
      useAppStore
        .getState()
        .workspaceRuntimeById[workspaceId]?.mcpServers.find(
          (server) => server.name === "figma-mcp",
        ),
    ).toMatchObject({
      name: "figma-mcp",
      enabled: true,
    });
    expect(useAppStore.getState().notifications.at(-1)).toMatchObject({
      title: "Connector not updated",
      audience: "foreground",
    });
  });
});
