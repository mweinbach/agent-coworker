import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { setupJsdom } from "./jsdomHarness";

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
  readonly responses: Array<{ id: string | number; result: unknown }> = [];

  constructor(
    public readonly opts: {
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

  async request(method: string, params?: unknown) {
    jsonRpcRequests.push({ method, params });
    const handler = jsonRpcHandlers.get(method);
    if (!handler) {
      return {};
    }
    return await handler(params);
  }

  respond(id: string | number, result: unknown) {
    this.responses.push({ id, result });
    return true;
  }

  close() {
    this.opts.onClose?.();
  }

  notify(method: string, params?: unknown) {
    act(() => {
      this.opts.onNotification?.({ method, params });
    });
  }

  requestFromServer(id: string | number, method: string, params?: unknown) {
    act(() => {
      this.opts.onServerRequest?.({ id, method, params });
    });
  }
}

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
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
}));

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { ChatView } = await import("../src/ui/ChatView");
const { RUNTIME, defaultThreadRuntime } = await import("../src/app/store.helpers");

function threadMeta(sessionId = "thread-session") {
  return {
    id: sessionId,
    title: "Recovered thread",
    modelProvider: "openai",
    model: "gpt-5.2",
    cwd: "/tmp/workspace",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    status: { type: "loaded" },
  };
}

function threadSnapshot(sessionId = "thread-session") {
  return {
    sessionId,
    title: "Recovered thread",
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
    lastMessagePreview: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    messageCount: 0,
    lastEventSeq: 0,
    feed: [],
    agents: [],
    todos: [],
    sessionUsage: null,
    lastTurnUsage: null,
    hasPendingAsk: false,
    hasPendingApproval: false,
  };
}

function setDefaultHandlers(sessionId = "thread-session") {
  jsonRpcHandlers.set("thread/list", async () => ({
    threads: [threadMeta(sessionId)],
  }));
  jsonRpcHandlers.set("thread/read", async () => ({
    coworkSnapshot: threadSnapshot(sessionId),
  }));
  jsonRpcHandlers.set("thread/resume", async () => ({
    thread: threadMeta(sessionId),
  }));
  jsonRpcHandlers.set("cowork/provider/catalog/read", async () => ({
    event: { type: "provider_catalog", sessionId: "jsonrpc-control", all: [], default: {}, connected: [] },
  }));
  jsonRpcHandlers.set("cowork/provider/authMethods/read", async () => ({
    event: { type: "provider_auth_methods", sessionId: "jsonrpc-control", methods: {} },
  }));
  jsonRpcHandlers.set("cowork/provider/status/refresh", async () => ({
    event: { type: "provider_status", sessionId: "jsonrpc-control", providers: [] },
  }));
  jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({
    event: {
      type: "mcp_servers",
      sessionId: "jsonrpc-control",
      servers: [],
      legacy: {
        workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: false },
        user: { path: "/tmp/home/.agent/mcp-servers.json", exists: false },
      },
      files: [],
    },
  }));
  jsonRpcHandlers.set("cowork/memory/list", async () => ({
    event: { type: "memory_list", sessionId: "jsonrpc-control", memories: [] },
  }));
  jsonRpcHandlers.set("cowork/skills/catalog/read", async () => ({
    event: {
      type: "skills_catalog",
      sessionId: "jsonrpc-control",
      catalog: { installations: [], sources: [], stats: { totalInstallations: 0, enabledInstallations: 0 } },
      mutationBlocked: false,
    },
  }));
  jsonRpcHandlers.set("cowork/skills/list", async () => ({
    event: { type: "skills_list", sessionId: "jsonrpc-control", skills: [] },
  }));
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("desktop JSON-RPC event mapping", () => {
  let workspaceId = "";
  let threadId = "";
  let sessionId = "";
  let harness: ReturnType<typeof setupJsdom> | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  async function reconnectThreadAndGetSocket() {
    await act(async () => {
      await useAppStore.getState().reconnectThread(threadId);
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();
    return socket as MockJsonRpcSocket;
  }

  async function expectPromptRequestToStayOnRequestPath(args: {
    socket: MockJsonRpcSocket;
    requestId: string;
    method: string;
    params?: Record<string, unknown>;
    expectedModal: Record<string, unknown>;
    expectedResponse: Record<string, unknown>;
    answer: () => void;
  }) {
    const { socket, requestId, method, params, expectedModal, expectedResponse, answer } = args;
    const openedPromptRequestIds: string[] = [];
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.promptModal !== prevState.promptModal && state.promptModal?.threadId === threadId) {
        openedPromptRequestIds.push(state.promptModal.prompt.requestId);
      }
    });
    const feedLengthBefore = useAppStore.getState().threadRuntimeById[threadId]?.feed.length ?? 0;
    const notificationCountBefore = useAppStore.getState().notifications.length;
    const responseCountBefore = socket.responses.length;

    try {
      socket.requestFromServer(requestId, method, params);
      await flushAsyncWork();
      await flushAsyncWork();

      expect(openedPromptRequestIds).toEqual([requestId]);
      expect(useAppStore.getState().promptModal).toMatchObject(expectedModal);
      expect(useAppStore.getState().threadRuntimeById[threadId]?.feed ?? []).toHaveLength(feedLengthBefore);
      expect(useAppStore.getState().notifications).toHaveLength(notificationCountBefore);

      await act(async () => {
        answer();
        await Promise.resolve();
      });

      expect(socket.responses.slice(responseCountBefore)).toEqual([{ id: requestId, result: expectedResponse }]);
      expect(useAppStore.getState().promptModal).toBeNull();
      expect(useAppStore.getState().threadRuntimeById[threadId]?.feed ?? []).toHaveLength(feedLengthBefore);
      expect(useAppStore.getState().notifications).toHaveLength(notificationCountBefore);
    } finally {
      unsubscribe();
    }
  }

  beforeEach(() => {
    harness = setupJsdom({
      includeAnimationFrame: true,
      extraGlobals: {
        MutationObserver: class MockMutationObserver {
          observe() {}
          disconnect() {}
          takeRecords() {
            return [];
          }
        },
      },
      setupWindow: (dom) => {
        Object.assign(dom.window, { event: undefined });
        if (typeof dom.window.HTMLElement.prototype.attachEvent !== "function") {
          (dom.window.HTMLElement.prototype as { attachEvent?: (name: string, handler: unknown) => void }).attachEvent = () => {};
        }
        if (typeof dom.window.HTMLElement.prototype.detachEvent !== "function") {
          (dom.window.HTMLElement.prototype as { detachEvent?: (name: string, handler: unknown) => void }).detachEvent = () => {};
        }
      },
    });
    const container = harness.dom.window.document.getElementById("root");
    if (!container) {
      throw new Error("missing root");
    }
    root = createRoot(container);

    setJsonRpcSocketOverride(MockJsonRpcSocket);
    workspaceId = `ws-${crypto.randomUUID()}`;
    threadId = `thread-${crypto.randomUUID()}`;
    sessionId = `session-${crypto.randomUUID()}`;

    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadSteers.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.modelStreamByThread.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    setDefaultHandlers(sessionId);

    act(() => {
      useAppStore.setState({
        ready: true,
        startupError: null,
        view: "chat",
        workspaces: [
          {
            id: workspaceId,
            name: "Workspace 1",
            path: "/tmp/workspace",
            createdAt: "2024-01-01T00:00:00.000Z",
            lastOpenedAt: "2024-01-01T00:00:00.000Z",
            defaultEnableMcp: true,
            defaultBackupsEnabled: true,
            yolo: false,
          },
        ],
        selectedWorkspaceId: workspaceId,
        selectedThreadId: threadId,
        threads: [
          {
            id: threadId,
            workspaceId,
            title: "Recovered thread",
            titleSource: "manual",
            createdAt: "2024-01-01T00:00:00.000Z",
            lastMessageAt: "2024-01-01T00:00:02.000Z",
            status: "disconnected",
            sessionId,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            legacyTranscriptId: null,
          },
        ],
        workspaceRuntimeById: {
          [workspaceId]: {
            serverUrl: "ws://mock",
            starting: false,
            error: null,
            controlSessionId: null,
            controlConfig: null,
            controlSessionConfig: null,
            controlEnableMcp: null,
            mcpServers: [],
            mcpLegacy: null,
            mcpFiles: [],
            mcpWarnings: [],
            mcpValidationByName: {},
            mcpLastAuthChallenge: null,
            mcpLastAuthResult: null,
            skills: [],
            skillsCatalog: null,
            selectedSkillName: null,
            selectedSkillContent: null,
            selectedSkillInstallationId: null,
            selectedSkillInstallation: null,
            selectedSkillPreview: null,
            skillUpdateChecksByInstallationId: {},
            skillCatalogLoading: false,
            skillCatalogError: null,
            skillsMutationBlocked: false,
            skillsMutationBlockedReason: null,
            skillMutationPendingKeys: {},
            skillMutationError: null,
            memories: [],
            memoriesLoading: false,
            workspaceBackupsPath: null,
            workspaceBackups: [],
            workspaceBackupsLoading: false,
            workspaceBackupsError: null,
            workspaceBackupPendingActionKeys: {},
            workspaceBackupDelta: null,
            workspaceBackupDeltaLoading: false,
            workspaceBackupDeltaError: null,
          },
        },
        threadRuntimeById: {
          [threadId]: {
            ...defaultThreadRuntime(),
            wsUrl: "ws://mock",
            sessionId,
          },
        },
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
      } as any);
    });

    act(() => {
      root?.render(createElement(ChatView));
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    harness?.restore();
    harness = null;
    clearJsonRpcSocketOverride();
  });

  test("shared JSON-RPC notifications stream assistant output and clear busy state", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "assistant-1",
      delta: "Hello from JSON-RPC",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { type: "agentMessage", text: "Hello from JSON-RPC" },
    });
    socket.notify("turn/completed", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "completed" },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    expect(runtime?.busy).toBe(false);
    expect(runtime?.activeTurnId).toBeNull();
    expect(runtime?.feed.some((item) => "text" in item && typeof item.text === "string" && item.text.includes("Hello from JSON-RPC"))).toBe(true);
  });

  test("shared JSON-RPC reasoning deltas render before the assistant reply", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/started", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        mode: "summary",
        text: "",
      },
    });
    socket.notify("item/reasoning/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "reasoning-1",
      mode: "summary",
      delta: "Inspecting the reports.",
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const reasoningOnlyFeed = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) =>
      item.kind === "reasoning" || item.kind === "message",
    ) ?? [];
    expect(reasoningOnlyFeed).toHaveLength(1);
    expect(reasoningOnlyFeed[0]).toMatchObject({
      kind: "reasoning",
      mode: "summary",
      text: "Inspecting the reports.",
    });

    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        mode: "summary",
        text: "Inspecting the reports.",
      },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "assistant-1",
      delta: "Final answer",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { id: "assistant-1", type: "agentMessage", text: "Final answer" },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) =>
      item.kind === "reasoning" || item.kind === "message",
    ) ?? [];
    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "message"]);
    expect(feed[0]).toMatchObject({
      kind: "reasoning",
      mode: "summary",
      text: "Inspecting the reports.",
    });
    expect(feed[1]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Final answer",
    });
  });

  test("shared JSON-RPC toolCall items render Gemini native web search cards", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/started", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "tool-1",
        type: "toolCall",
        toolName: "nativeWebSearch",
        state: "input-streaming",
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "tool-1",
        type: "toolCall",
        toolName: "nativeWebSearch",
        state: "output-available",
        args: { queries: ["Project Hail Mary movie reviews"] },
        result: {
          provider: "google",
          status: "completed",
          queries: ["Project Hail Mary movie reviews"],
          results: [{ title: "MovieWeb" }],
        },
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const tools = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) => item.kind === "tool") ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      kind: "tool",
      name: "nativeWebSearch",
      state: "output-available",
      args: { queries: ["Project Hail Mary movie reviews"] },
      result: {
        provider: "google",
        status: "completed",
        queries: ["Project Hail Mary movie reviews"],
        results: [{ title: "MovieWeb" }],
      },
    });
  });

  test("completed-only JSON-RPC reasoning items preserve harness ordering before the assistant reply", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-final",
        type: "reasoning",
        mode: "reasoning",
        text: "Late synthesis.",
      },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "assistant-1",
      delta: "Final answer",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { id: "assistant-1", type: "agentMessage", text: "Final answer" },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) =>
      item.kind === "reasoning" || item.kind === "message"
    ) ?? [];
    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "message"]);
    expect(feed[0]).toMatchObject({
      kind: "reasoning",
      mode: "reasoning",
      text: "Late synthesis.",
    });
    expect(feed[1]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Final answer",
    });
  });

  test("completed-only JSON-RPC reasoning stays after a completed intermediate assistant item", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "assistant-1",
      delta: "First draft",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { id: "assistant-1", type: "agentMessage", text: "First draft" },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-2",
        type: "reasoning",
        mode: "reasoning",
        text: "Need one more search.",
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "tool-1",
        type: "toolCall",
        toolName: "nativeWebSearch",
        state: "output-available",
        args: { queries: ["Project Hail Mary reception"] },
        result: { queries: ["Project Hail Mary reception"], results: [{ title: "MovieWeb" }] },
      },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "assistant-2",
      delta: "Final answer",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: { id: "assistant-2", type: "agentMessage", text: "Final answer" },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) =>
      item.kind === "reasoning" || item.kind === "tool" || item.kind === "message"
    ) ?? [];
    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "tool", "message"]);
    expect(feed[0]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "First draft",
    });
    expect(feed[1]).toMatchObject({
      kind: "reasoning",
      mode: "reasoning",
      text: "Need one more search.",
    });
    expect(feed[2]).toMatchObject({
      kind: "tool",
      name: "nativeWebSearch",
      state: "output-available",
    });
    expect(feed[3]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Final answer",
    });
  });

  test("shared JSON-RPC follow-up activity applies harness-segmented assistant items while streaming", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "agentMessage:turn-1",
      delta: "Let me rewrite the script.\n",
    });
    socket.notify("item/started", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        mode: "reasoning",
        text: "",
      },
    });
    socket.notify("item/reasoning/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "reasoning-1",
      mode: "reasoning",
      delta: "I should inspect the current file first.",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        mode: "reasoning",
        text: "I should inspect the current file first.",
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "tool-1",
        type: "toolCall",
        toolName: "Read",
        state: "output-available",
        args: { filePath: "/tmp/create_smci_report.py" },
        result: { path: "/tmp/create_smci_report.py", receivedChars: 17037 },
      },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "agentMessage:turn-1:2",
      delta: "Now let me run the updated script.\n",
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "tool-2",
        type: "toolCall",
        toolName: "Bash",
        state: "output-error",
        args: { command: "python create_smci_report.py" },
        result: { error: "Exit code: 1" },
      },
    });
    socket.notify("item/agentMessage/delta", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "agentMessage:turn-1:3",
      delta: "I need to fix the parameter and run it again.\n",
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const liveFeed = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) =>
      item.kind === "reasoning" || item.kind === "tool" || item.kind === "message"
    ) ?? [];
    expect(liveFeed.map((item) => item.kind)).toEqual(["message", "reasoning", "tool", "message", "tool", "message"]);
    expect(liveFeed[0]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Let me rewrite the script.\n",
    });
    expect(liveFeed[1]).toMatchObject({
      kind: "reasoning",
      text: "I should inspect the current file first.",
    });
    expect(liveFeed[2]).toMatchObject({
      kind: "tool",
      name: "Read",
      state: "output-available",
    });
    expect(liveFeed[3]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "Now let me run the updated script.\n",
    });
    expect(liveFeed[4]).toMatchObject({
      kind: "tool",
      name: "Bash",
      state: "output-error",
    });
    expect(liveFeed[5]).toMatchObject({
      kind: "message",
      role: "assistant",
      text: "I need to fix the parameter and run it again.\n",
    });

    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "agentMessage:turn-1",
        type: "agentMessage",
        text: "Let me rewrite the script.\n",
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "agentMessage:turn-1:2",
        type: "agentMessage",
        text: "Now let me run the updated script.\n",
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "agentMessage:turn-1:3",
        type: "agentMessage",
        text: "I need to fix the parameter and run it again.\n",
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const completedFeed = useAppStore.getState().threadRuntimeById[threadId]?.feed.filter((item) =>
      item.kind === "reasoning" || item.kind === "tool" || item.kind === "message"
    ) ?? [];
    expect(completedFeed.map((item) => item.kind)).toEqual(["message", "reasoning", "tool", "message", "tool", "message"]);
  });

  test("shared JSON-RPC notifications hydrate live session metadata immediately", async () => {
    const socket = await reconnectThreadAndGetSocket();

    socket.notify("cowork/session/info", {
      type: "session_info",
      sessionId,
      title: "Renamed over JSON-RPC",
      titleSource: "manual",
      titleModel: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:03.000Z",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    socket.notify("cowork/session/configUpdated", {
      type: "config_updated",
      sessionId,
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
        workingDirectory: "/tmp/workspace",
      },
    });
    socket.notify("cowork/session/settings", {
      type: "session_settings",
      sessionId,
      enableMcp: false,
      enableMemory: true,
      memoryRequireApproval: false,
    });
    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
      config: {
        yolo: false,
        observabilityEnabled: false,
        backupsEnabled: true,
        defaultBackupsEnabled: true,
        enableMemory: true,
        memoryRequireApproval: false,
        preferredChildModel: "gpt-5.4-mini",
        childModelRoutingMode: "same-provider",
        preferredChildModelRef: "openai:gpt-5.4-mini",
        allowedChildModelRefs: [],
        maxSteps: 100,
        toolOutputOverflowChars: 25000,
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.title).toBe("Renamed over JSON-RPC");
    expect(runtime?.config?.model).toBe("gpt-5.4-mini");
    expect(runtime?.enableMcp).toBe(false);
    expect(runtime?.sessionConfig?.preferredChildModel).toBe("gpt-5.4-mini");
  });

  test("shared JSON-RPC notifications map remaining live thread events", async () => {
    const socket = await reconnectThreadAndGetSocket();

    RUNTIME.pendingThreadSteers.set(threadId, new Map([
      ["steer-1", {
        clientMessageId: "steer-1",
        text: "tighten scope",
        expectedTurnId: "turn-1",
        accepted: false,
      }],
    ]));
    act(() => {
      useAppStore.setState((state) => ({
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...state.threadRuntimeById[threadId]!,
            busy: true,
            activeTurnId: "turn-1",
            pendingSteer: {
              clientMessageId: "steer-1",
              text: "tighten scope",
              status: "sending",
            },
          },
        },
      }));
    });

    socket.notify("cowork/session/steerAccepted", {
      type: "steer_accepted",
      sessionId,
      turnId: "turn-1",
      text: "tighten scope",
      clientMessageId: "steer-1",
    });
    socket.notify("cowork/session/agentList", {
      type: "agent_list",
      sessionId,
      agents: [{
        agentId: "agent-1",
        parentSessionId: sessionId,
        role: "research",
        mode: "delegate",
        depth: 1,
        title: "Research worker",
        provider: "openai",
        effectiveModel: "gpt-5.4-mini",
        createdAt: "2024-01-01T00:00:01.000Z",
        updatedAt: "2024-01-01T00:00:02.000Z",
        lifecycleState: "active",
        executionState: "running",
        busy: true,
      }],
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: null,
      item: {
        id: "todos-1",
        type: "todos",
        todos: [{ content: "Ship the fix", status: "pending", activeForm: "" }],
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: null,
      item: {
        id: "log-1",
        type: "log",
        line: "live log line",
      },
    });
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: null,
      item: {
        id: "error-1",
        type: "error",
        source: "session",
        code: "internal_error",
        message: "boom",
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const state = useAppStore.getState();
    const runtime = state.threadRuntimeById[threadId];
    expect(runtime?.pendingSteer?.status).toBe("accepted");
    expect(runtime?.agents).toHaveLength(1);
    expect(state.latestTodosByThreadId[threadId]).toEqual([{ content: "Ship the fix", status: "pending", activeForm: "" }]);
    expect(runtime?.feed.some((item) => item.kind === "log" && item.line === "live log line")).toBe(true);
    expect(runtime?.feed.some((item) => item.kind === "error" && item.message === "boom")).toBe(true);
    expect(state.notifications.some((entry) => entry.detail === "session/internal_error: boom")).toBe(true);
  });

  test("server ask requests stay on the request path and answerAsk responds on the shared socket", async () => {
    const socket = await reconnectThreadAndGetSocket();

    await expectPromptRequestToStayOnRequestPath({
      socket,
      requestId: "ask-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: sessionId,
        turnId: "turn-1",
        itemId: "item-1",
        question: "Continue?",
        options: ["Yes", "No"],
      },
      expectedModal: {
        kind: "ask",
        threadId,
        prompt: {
          requestId: "ask-1",
          question: "Continue?",
          options: ["Yes", "No"],
        },
      },
      expectedResponse: { answer: "Yes" },
      answer: () => useAppStore.getState().answerAsk(threadId, "ask-1", "Yes"),
    });
  });

  test("server approval requests stay on the request path and answerApproval responds on the shared socket", async () => {
    const socket = await reconnectThreadAndGetSocket();

    await expectPromptRequestToStayOnRequestPath({
      socket,
      requestId: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: sessionId,
        turnId: "turn-1",
        itemId: "item-2",
        command: "rm -rf build",
        dangerous: true,
        reason: "requires_manual_review",
      },
      expectedModal: {
        kind: "approval",
        threadId,
        prompt: {
          requestId: "approval-1",
          command: "rm -rf build",
          dangerous: true,
          reasonCode: "requires_manual_review",
        },
      },
      expectedResponse: { decision: "accept" },
      answer: () => useAppStore.getState().answerApproval(threadId, "approval-1", true),
    });
  });

  test("retired shared JSON-RPC sockets do not route late notifications or server requests after a serverUrl swap", async () => {
    const firstSocket = await reconnectThreadAndGetSocket();

    act(() => {
      useAppStore.setState((state) => ({
        workspaceRuntimeById: {
          ...state.workspaceRuntimeById,
          [workspaceId]: {
            ...state.workspaceRuntimeById[workspaceId],
            serverUrl: "ws://changed",
          },
        },
      }));
    });
    await act(async () => {
      await useAppStore.getState().reconnectThread(threadId);
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const secondSocket = MockJsonRpcSocket.instances[1];
    expect(secondSocket).toBeDefined();
    expect(secondSocket).not.toBe(firstSocket);
    expect(RUNTIME.jsonRpcSockets.get(workspaceId)).toBe(secondSocket);

    firstSocket.notify("item/completed", {
      threadId: sessionId,
      turnId: null,
      item: {
        id: "log-stale",
        type: "log",
        line: "stale retired log line",
      },
    });
    firstSocket.requestFromServer("ask-stale", "item/tool/requestUserInput", {
      threadId: sessionId,
      turnId: "turn-stale",
      itemId: "item-stale",
      question: "Ignore me?",
      options: ["Yes", "No"],
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(useAppStore.getState().promptModal).toBeNull();
    expect(firstSocket.responses).toEqual([]);
    expect(secondSocket.responses).toEqual([]);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed.some((item) =>
      item.kind === "log" && item.line === "stale retired log line"
    )).toBe(false);

    secondSocket.notify("item/completed", {
      threadId: sessionId,
      turnId: null,
      item: {
        id: "log-fresh",
        type: "log",
        line: "fresh replacement log line",
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed.some((item) =>
      item.kind === "log" && item.line === "fresh replacement log line"
    )).toBe(true);

    await expectPromptRequestToStayOnRequestPath({
      socket: secondSocket,
      requestId: "ask-fresh",
      method: "item/tool/requestUserInput",
      params: {
        threadId: sessionId,
        turnId: "turn-fresh",
        itemId: "item-fresh",
        question: "Continue on replacement?",
        options: ["Yes", "No"],
      },
      expectedModal: {
        kind: "ask",
        threadId,
        prompt: {
          requestId: "ask-fresh",
          question: "Continue on replacement?",
          options: ["Yes", "No"],
        },
      },
      expectedResponse: { answer: "Yes" },
      answer: () => useAppStore.getState().answerAsk(threadId, "ask-fresh", "Yes"),
    });
  });

  test("shared JSON-RPC user message notifications reconcile optimistic sends", async () => {
    const socket = await reconnectThreadAndGetSocket();

    await act(async () => {
      await useAppStore.getState().sendMessage("hello once");
    });
    await flushAsyncWork();

    const turnStartParams = jsonRpcRequests.find((entry) => entry.method === "turn/start")?.params as
      | { clientMessageId?: string }
      | undefined;
    expect(turnStartParams?.clientMessageId).toEqual(expect.any(String));

    socket.notify("turn/started", {
      threadId: sessionId,
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    socket.notify("item/started", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "user-item-1",
        type: "userMessage",
        clientMessageId: turnStartParams?.clientMessageId,
        content: [{ type: "text", text: "hello once" }],
      },
    });
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    const userMessages = runtime?.feed.filter((item) => item.kind === "message" && item.role === "user") ?? [];
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: turnStartParams?.clientMessageId,
      text: "hello once",
    });
  });
});
