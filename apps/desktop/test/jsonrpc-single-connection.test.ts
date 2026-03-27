import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const startCalls: Array<{ workspaceId: string; workspacePath: string; yolo: boolean }> = [];
const savedStates: any[] = [];
const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcRequestHandlers = new Map<string, (params?: unknown) => unknown | Promise<unknown>>();
const jsonRpcRequestFailures = new Map<string, string>();

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
    const failure = jsonRpcRequestFailures.get(method);
    if (failure) {
      throw new Error(failure);
    }
    const handler = jsonRpcRequestHandlers.get(method);
    if (handler) {
      return await handler(params);
    }
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

mock.module("../src/lib/desktopCommands", () => createDesktopCommandsMock({
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
}));

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME, defaultThreadRuntime, defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");

async function flushAsyncWork() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function seedActiveThreadState() {
  useAppStore.setState({
    selectedWorkspaceId: "ws-jsonrpc",
    selectedThreadId: "jsonrpc-thread-1",
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
    threads: [
      {
        id: "jsonrpc-thread-1",
        workspaceId: "ws-jsonrpc",
        title: "New session",
        createdAt: "2026-03-21T00:00:00.000Z",
        lastMessageAt: "2026-03-21T00:00:00.000Z",
        status: "active",
        sessionId: "jsonrpc-thread-1",
        messageCount: 0,
        lastEventSeq: 0,
      },
    ],
    workspaceRuntimeById: {
      "ws-jsonrpc": {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://jsonrpc-workspace",
      },
    },
    threadRuntimeById: {
      "jsonrpc-thread-1": {
        ...defaultThreadRuntime(),
        wsUrl: "ws://jsonrpc-workspace",
        connected: true,
        sessionId: "jsonrpc-thread-1",
      },
    },
    composerText: "",
  } as any);
}

describe("desktop JSON-RPC single connection path", () => {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    startCalls.length = 0;
    savedStates.length = 0;
    jsonRpcRequests.length = 0;
    jsonRpcRequestHandlers.clear();
    jsonRpcRequestFailures.clear();
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.pendingThreadAttachments.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadSteers.clear();
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

  afterEach(() => {
    clearJsonRpcSocketOverride();
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
      "cowork/session/state/read",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
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

  test("surfaces turn/start rejection as an error without changing optimistic send semantics", async () => {
    seedActiveThreadState();
    jsonRpcRequestFailures.set("turn/start", "turn/start failed");

    await useAppStore.getState().sendMessage("hello over jsonrpc");
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(runtime?.feed.map((item) => item.kind)).toEqual(["message", "error"]);
    expect(runtime?.feed.at(-1)).toMatchObject({
      kind: "error",
      message: "Not connected. Reconnect to continue.",
      code: "internal_error",
      source: "protocol",
    });
    expect(useAppStore.getState().composerText).toBe("");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("turn/start");
  });

  test("sends attachment-only turns without placeholder text in the JSON-RPC input", async () => {
    seedActiveThreadState();
    const attachment = {
      filename: "photo.png",
      contentBase64: "aGVsbG8=",
      mimeType: "image/png",
    };

    await useAppStore.getState().sendMessage("", "reject", [attachment]);
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(runtime?.feed.at(-1)).toMatchObject({
      kind: "message",
      role: "user",
      text: "[photo.png]",
    });
    expect(jsonRpcRequests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      threadId: "jsonrpc-thread-1",
      input: [{ type: "file", ...attachment }],
      clientMessageId: expect.any(String),
    });
  });

  test("attachment-only transcript sends create a live session immediately", async () => {
    useAppStore.setState({
      selectedWorkspaceId: "ws-jsonrpc",
      selectedThreadId: "transcript-thread",
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
      threads: [
        {
          id: "transcript-thread",
          workspaceId: "ws-jsonrpc",
          title: "Recovered transcript",
          createdAt: "2026-03-21T00:00:00.000Z",
          lastMessageAt: "2026-03-21T00:00:00.000Z",
          status: "active",
          sessionId: null,
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
      workspaceRuntimeById: {
        "ws-jsonrpc": {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://jsonrpc-workspace",
        },
      },
      threadRuntimeById: {
        "transcript-thread": {
          ...defaultThreadRuntime(),
          transcriptOnly: true,
          feed: [],
        },
      },
      composerText: "",
    } as any);

    const attachment = {
      filename: "transcript.png",
      contentBase64: "aGVsbG8=",
      mimeType: "image/png",
    };

    const accepted = await useAppStore.getState().sendMessage("", "reject", [attachment]);
    await flushAsyncWork();

    expect(accepted).toBe(true);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/start");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("turn/start");
    expect(jsonRpcRequests.find((entry) => entry.method === "turn/start")?.params).toMatchObject({
      threadId: "jsonrpc-thread-1",
      input: [{ type: "file", ...attachment }],
      clientMessageId: expect.any(String),
    });
  });

  test("clears pending steer state when turn/steer rejects", async () => {
    seedActiveThreadState();
    useAppStore.setState({
      threadRuntimeById: {
        ...useAppStore.getState().threadRuntimeById,
        "jsonrpc-thread-1": {
          ...defaultThreadRuntime(),
          wsUrl: "ws://jsonrpc-workspace",
          connected: true,
          sessionId: "jsonrpc-thread-1",
          busy: true,
          activeTurnId: "turn-1",
        },
      },
    } as any);
    jsonRpcRequestFailures.set("turn/steer", "turn/steer failed");

    await useAppStore.getState().sendMessage("tighten the scope", "steer");
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(runtime?.pendingSteer).toBeNull();
    expect(RUNTIME.pendingThreadSteers.get("jsonrpc-thread-1")).toBeUndefined();
    expect(runtime?.feed.at(-1)).toMatchObject({
      kind: "error",
      message: "Not connected. Reconnect to continue.",
      code: "internal_error",
      source: "protocol",
    });
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("turn/steer");
  });

  test("does not drop same-text steer requests when the attachments change", async () => {
    seedActiveThreadState();
    useAppStore.setState({
      threadRuntimeById: {
        ...useAppStore.getState().threadRuntimeById,
        "jsonrpc-thread-1": {
          ...defaultThreadRuntime(),
          wsUrl: "ws://jsonrpc-workspace",
          connected: true,
          sessionId: "jsonrpc-thread-1",
          busy: true,
          activeTurnId: "turn-1",
        },
      },
    } as any);

    await useAppStore.getState().sendMessage("", "steer", [{
      filename: "first.png",
      contentBase64: "Zmlyc3Q=",
      mimeType: "image/png",
    }]);
    await flushAsyncWork();
    useAppStore.setState((state) => ({
      selectedWorkspaceId: "ws-jsonrpc",
      selectedThreadId: "jsonrpc-thread-1",
      workspaces: state.workspaces.length > 0 ? state.workspaces : [{
        id: "ws-jsonrpc",
        name: "JSON-RPC Workspace",
        path: "/tmp/jsonrpc-workspace",
        createdAt: "2026-03-21T00:00:00.000Z",
        lastOpenedAt: "2026-03-21T00:00:00.000Z",
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      }],
      threads: state.threads.length > 0 ? state.threads : [{
        id: "jsonrpc-thread-1",
        workspaceId: "ws-jsonrpc",
        title: "New session",
        createdAt: "2026-03-21T00:00:00.000Z",
        lastMessageAt: "2026-03-21T00:00:00.000Z",
        status: "active",
        sessionId: "jsonrpc-thread-1",
        messageCount: 0,
        lastEventSeq: 0,
      }],
    }) as any);

    const secondAccepted = await useAppStore.getState().sendMessage("", "steer", [{
      filename: "second.png",
      contentBase64: "c2Vjb25k",
      mimeType: "image/png",
    }]);
    await flushAsyncWork();

    expect(secondAccepted).toBe(true);
    expect(jsonRpcRequests.filter((entry) => entry.method === "turn/steer")).toHaveLength(2);
    const runtime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(runtime?.pendingSteer).toMatchObject({
      text: "",
      attachmentSignature: expect.any(String),
      status: "sending",
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
      "cowork/session/state/read",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
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
      "cowork/session/state/read",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
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
      "cowork/session/state/read",
      "cowork/provider/catalog/read",
      "cowork/provider/authMethods/read",
      "cowork/provider/status/refresh",
      "cowork/mcp/servers/read",
      "cowork/memory/list",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
      "thread/list",
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

  test("delayed thread/read does not clobber optimistic first-message feed items", async () => {
    let resolveThreadRead: ((value: unknown) => void) | null = null;
    jsonRpcRequestHandlers.set("thread/read", async () => await new Promise((resolve) => {
      resolveThreadRead = resolve;
    }));

    const newThreadPromise = useAppStore.getState().newThread({
      workspaceId: "ws-jsonrpc",
      titleHint: "Draft",
      firstMessage: "hello over jsonrpc",
    });

    await flushAsyncWork();
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();

    const turnStartParams = jsonRpcRequests.find((entry) => entry.method === "turn/start")?.params as
      | { clientMessageId?: string }
      | undefined;
    expect(turnStartParams?.clientMessageId).toEqual(expect.any(String));

    const optimisticRuntime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(optimisticRuntime?.feed).toContainEqual(expect.objectContaining({
      id: turnStartParams?.clientMessageId,
      kind: "message",
      role: "user",
      text: "hello over jsonrpc",
    }));

    socket.notify("turn/started", {
      threadId: "jsonrpc-thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: "jsonrpc-thread-1",
      turnId: "turn-1",
      itemId: "assistant-1",
      delta: "Live answer",
    });
    socket.notify("item/completed", {
      threadId: "jsonrpc-thread-1",
      turnId: "turn-1",
      item: { id: "assistant-1", type: "agentMessage", text: "Live answer" },
    });
    await flushAsyncWork();

    resolveThreadRead?.({
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
    });

    await newThreadPromise;
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById["jsonrpc-thread-1"];
    expect(runtime?.feed).toContainEqual(expect.objectContaining({
      id: turnStartParams?.clientMessageId,
      kind: "message",
      role: "user",
      text: "hello over jsonrpc",
    }));
    expect(runtime?.feed).toContainEqual(expect.objectContaining({
      kind: "message",
      role: "assistant",
      text: "Live answer",
    }));
  });
});
