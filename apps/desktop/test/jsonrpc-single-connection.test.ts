import { beforeEach, describe, expect, mock, test } from "bun:test";

const startCalls: Array<{ workspaceId: string; workspacePath: string; yolo: boolean }> = [];
const savedStates: any[] = [];
const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];

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

class MockAgentSocket {
  connect() {}
  send() {
    return true;
  }
  close() {}
}

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();

  constructor(public readonly opts: { onOpen?: () => void; onNotification?: (message: { method: string; params?: unknown }) => void }) {
    MockJsonRpcSocket.instances.push(this);
  }

  private notify(method: string, params: unknown) {
    this.opts.onNotification?.({
      method,
      params,
    });
  }

  connect() {
    this.opts.onOpen?.();
  }

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    if (method === "thread/list") {
      return {
        threads: [],
      };
    }
    if (method === "thread/start") {
      return {
        thread: {
          id: "jsonrpc-thread-1",
          title: "New session",
          modelProvider: "google",
          model: "gemini-3.1-pro-preview",
          cwd: "/tmp/jsonrpc-workspace",
          createdAt: "2026-03-21T00:00:00.000Z",
          updatedAt: "2026-03-21T00:00:00.000Z",
          status: { type: "loaded" },
        },
      };
    }
    if (method === "turn/start") {
      return {
        turn: {
          id: "turn-1",
          threadId: "jsonrpc-thread-1",
          status: "inProgress",
          items: [],
        },
      };
    }
    if (method === "thread/read") {
      return {
        coworkSnapshot: {
          sessionId: "jsonrpc-thread-1",
          title: "New session",
          titleSource: "default",
          titleModel: null,
          provider: "google",
          model: "gemini-3.1-pro-preview",
          sessionKind: "root",
          parentSessionId: null,
          role: null,
          mode: null,
          depth: null,
          nickname: null,
          requestedModel: null,
          effectiveModel: null,
          requestedReasoningEffort: null,
          effectiveReasoningEffort: null,
          executionState: null,
          lastMessagePreview: null,
          createdAt: "2026-03-21T00:00:00.000Z",
          updatedAt: "2026-03-21T00:00:00.000Z",
          messageCount: 0,
          lastEventSeq: 0,
          feed: [],
          agents: [],
          todos: [],
          sessionUsage: null,
          lastTurnUsage: null,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      };
    }
    if (method === "cowork/session/title/set") {
      const event = {
        type: "session_info",
        sessionId: "jsonrpc-thread-1",
        title: params && typeof (params as any).title === "string" ? (params as any).title : "Renamed",
        titleSource: "manual",
        titleModel: null,
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
        provider: "google",
        model: "gemini-3.1-pro-preview",
      };
      this.notify("cowork/session/info", event);
      return {
        event,
      };
    }
    if (method === "cowork/session/model/set") {
      const event = {
        type: "config_updated",
        sessionId: "jsonrpc-thread-1",
        config: {
          provider: (params as any)?.provider ?? "google",
          model: (params as any)?.model ?? "gemini-3.1-pro-preview",
          workingDirectory: "/tmp/jsonrpc-workspace",
        },
      };
      this.notify("cowork/session/configUpdated", event);
      return {
        event,
      };
    }
    if (method === "cowork/session/usageBudget/set") {
      const event = {
        type: "session_usage",
        sessionId: "jsonrpc-thread-1",
        usage: null,
      };
      this.notify("cowork/session/usage", event);
      return {
        event,
      };
    }
    if (method === "cowork/session/defaults/apply") {
      const threadId = typeof (params as any)?.threadId === "string" ? (params as any).threadId : null;
      const configEvent = {
        type: "session_config",
        sessionId: threadId ?? "jsonrpc-control",
        config: {
          yolo: false,
          observabilityEnabled: true,
          backupsEnabled: true,
          defaultBackupsEnabled: true,
          enableMemory: true,
          memoryRequireApproval: false,
          preferredChildModel: "gemini-3.1-pro-preview",
          childModelRoutingMode: "same-provider",
          preferredChildModelRef: "google:gemini-3.1-pro-preview",
          allowedChildModelRefs: [],
          maxSteps: 100,
          toolOutputOverflowChars: 25000,
          userName: "",
          userProfile: { instructions: "", work: "", details: "" },
        },
      };
      if (threadId) {
        if (typeof (params as any)?.provider === "string" && typeof (params as any)?.model === "string") {
          this.notify("cowork/session/configUpdated", {
            type: "config_updated",
            sessionId: threadId,
            config: {
              provider: (params as any).provider,
              model: (params as any).model,
              workingDirectory: "/tmp/jsonrpc-workspace",
            },
          });
        }
        if (typeof (params as any)?.enableMcp === "boolean") {
          this.notify("cowork/session/settings", {
            type: "session_settings",
            sessionId: threadId,
            enableMcp: (params as any).enableMcp,
            enableMemory: true,
            memoryRequireApproval: false,
          });
        }
        this.notify("cowork/session/config", configEvent);
      }
      return {
        event: configEvent,
      };
    }
    if (method === "cowork/provider/catalog/read") {
      return {
        event: {
          type: "provider_catalog",
          sessionId: "jsonrpc-control",
          all: [{ id: "google", name: "Google", models: [], defaultModel: "gemini-3.1-pro-preview" }],
          default: { google: "gemini-3.1-pro-preview" },
          connected: ["google"],
        },
      };
    }
    if (method === "cowork/memory/list") {
      return {
        event: {
          type: "memory_list",
          sessionId: "jsonrpc-control",
          memories: [{ id: "mem-1", scope: "workspace", content: "Remember this", createdAt: "2026-03-21T00:00:00.000Z", updatedAt: "2026-03-21T00:00:00.000Z" }],
        },
      };
    }
    if (method === "cowork/backups/workspace/read") {
      return {
        event: {
          type: "workspace_backups",
          sessionId: "jsonrpc-control",
          workspacePath: "/tmp/jsonrpc-workspace",
          backups: [],
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
            workspace: { path: "/tmp/jsonrpc-workspace/.agent/mcp-servers.json", exists: false },
            user: { path: "/home/test/.agent/mcp-servers.json", exists: false },
          },
          files: [],
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
    return {};
  }

  respond() {
    return true;
  }

  close() {}
}

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  saveState: async (state: any) => {
    savedStates.push(state);
  },
  startWorkspaceServer: async (opts: { workspaceId: string; workspacePath: string; yolo: boolean }) => {
    startCalls.push(opts);
    return { url: "ws://jsonrpc-workspace" };
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
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME } = await import("../src/app/store.helpers");

async function flushAsyncWork() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("desktop JSON-RPC single connection path", () => {
  beforeEach(() => {
    startCalls.length = 0;
    savedStates.length = 0;
    jsonRpcRequests.length = 0;
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.modelStreamByThread.clear();
    useAppStore.setState({
      ready: true,
      startupError: null,
      view: "chat",
      workspaces: [
        {
          id: "ws-jsonrpc",
          name: "JSON-RPC Workspace",
          path: "/tmp/jsonrpc-workspace",
          createdAt: "2026-03-21T00:00:00.000Z",
          lastOpenedAt: "2026-03-21T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      selectedWorkspaceId: null,
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
      perWorkspaceSettings: false,
    } as any);
  });

  test("uses one workspace JsonRpcSocket for thread start and turn start", async () => {
    await useAppStore.getState().selectWorkspace("ws-jsonrpc");
    await useAppStore.getState().newThread({
      workspaceId: "ws-jsonrpc",
      titleHint: "Draft",
      firstMessage: "hello over jsonrpc",
    });
    await flushAsyncWork();

    expect(RUNTIME.jsonRpcSockets.has("ws-jsonrpc")).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toEqual([
      "thread/list",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
      "thread/start",
      "cowork/session/defaults/apply",
      "thread/read",
      "turn/start",
    ]);
    const turnStartParams = jsonRpcRequests.find((entry) => entry.method === "turn/start")?.params as
      | { threadId?: string; clientMessageId?: string }
      | undefined;
    expect(turnStartParams?.threadId).toBe("jsonrpc-thread-1");
    expect(turnStartParams?.clientMessageId).toEqual(expect.any(String));

    const state = useAppStore.getState();
    expect(state.threads[0]?.id).toBe("jsonrpc-thread-1");
    expect(state.threadRuntimeById["jsonrpc-thread-1"]?.sessionId).toBe("jsonrpc-thread-1");
    expect(state.threadRuntimeById["jsonrpc-thread-1"]?.connected).toBe(true);
    expect(jsonRpcRequests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      threadId: "jsonrpc-thread-1",
      input: [{ type: "text", text: "hello over jsonrpc" }],
      clientMessageId: expect.any(String),
    });
  });

  test("routes provider, memory, and backup control requests over the shared JsonRpcSocket", async () => {
    await useAppStore.getState().selectWorkspace("ws-jsonrpc");
    await useAppStore.getState().requestProviderCatalog();
    await useAppStore.getState().requestWorkspaceMemories("ws-jsonrpc");
    await useAppStore.getState().requestWorkspaceBackups("ws-jsonrpc");
    await flushAsyncWork();

    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toEqual([
      "thread/list",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
      "cowork/provider/catalog/read",
      "cowork/memory/list",
      "cowork/backups/workspace/read",
    ]);

    const state = useAppStore.getState();
    expect(state.providerCatalog).toHaveLength(1);
    expect(state.workspaceRuntimeById["ws-jsonrpc"]?.memories).toHaveLength(1);
    expect(state.workspaceRuntimeById["ws-jsonrpc"]?.workspaceBackups).toEqual([]);
  });

  test("routes MCP and skills control requests over the shared JsonRpcSocket", async () => {
    await useAppStore.getState().selectWorkspace("ws-jsonrpc");
    await useAppStore.getState().requestWorkspaceMcpServers("ws-jsonrpc");
    await useAppStore.getState().refreshSkillsCatalog();
    await flushAsyncWork();

    expect(jsonRpcRequests.map((entry) => entry.method)).toEqual([
      "thread/list",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
      "cowork/mcp/servers/read",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
    ]);

    const runtime = useAppStore.getState().workspaceRuntimeById["ws-jsonrpc"];
    expect(runtime?.mcpServers).toEqual([]);
    expect(runtime?.skillsCatalog?.installations).toEqual([]);
    expect(runtime?.skills).toEqual([]);
  });

  test("routes remaining thread and workspace-default controls over the shared JsonRpcSocket", async () => {
    await useAppStore.getState().selectWorkspace("ws-jsonrpc");
    await useAppStore.getState().newThread({
      workspaceId: "ws-jsonrpc",
      titleHint: "Draft",
      firstMessage: "hello over jsonrpc",
    });
    await flushAsyncWork();

    useAppStore.getState().renameThread("jsonrpc-thread-1", "Renamed thread");
    useAppStore.getState().setThreadModel("jsonrpc-thread-1", "google", "gemini-3.1-flash-lite-preview");
    useAppStore.getState().clearThreadUsageHardCap("jsonrpc-thread-1");
    await useAppStore.getState().updateWorkspaceDefaults("ws-jsonrpc", {
      defaultEnableMcp: false,
    });
    await flushAsyncWork();

    expect(jsonRpcRequests.map((entry) => entry.method)).toEqual([
      "thread/list",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
      "thread/start",
      "cowork/session/defaults/apply",
      "thread/read",
      "turn/start",
      "cowork/session/title/set",
      "cowork/session/model/set",
      "cowork/session/usageBudget/set",
      "cowork/session/defaults/apply",
      "cowork/session/defaults/apply",
    ]);

    const runtime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(useAppStore.getState().threads.find((thread) => thread.id === "jsonrpc-thread-1")?.title).toBe("Renamed thread");
    expect(runtime?.enableMcp).toBe(false);
  });

  test("draft model selection applies before the first turn starts", async () => {
    await useAppStore.getState().selectWorkspace("ws-jsonrpc");
    await useAppStore.getState().newThread({
      workspaceId: "ws-jsonrpc",
      titleHint: "Draft only",
    });

    const draftThreadId = useAppStore.getState().selectedThreadId;
    expect(draftThreadId).toBeTruthy();
    useAppStore.getState().setThreadModel(draftThreadId!, "openai", "gpt-5.4-mini");
    jsonRpcRequests.length = 0;

    await useAppStore.getState().sendMessage("use the draft selection");
    await flushAsyncWork();

    expect(jsonRpcRequests.map((entry) => entry.method)).toEqual([
      "thread/list",
      "thread/start",
      "cowork/session/defaults/apply",
      "thread/read",
      "turn/start",
    ]);
    expect(jsonRpcRequests.find((entry) => entry.method === "cowork/session/defaults/apply")?.params).toMatchObject({
      threadId: "jsonrpc-thread-1",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"]?.config?.model).toBe("gpt-5.4-mini");
    expect(useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"]?.config?.provider).toBe("openai");
  });
});
