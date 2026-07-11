import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { composerDraftKeyForThread, createEmptyComposerDraft } from "../src/app/composerDrafts";
import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";
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
      onServerResponse?: (message: any) => void;
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

  respondFromServer(
    id: string | number,
    response: { result?: unknown; error?: { code: number; message: string; data?: unknown } },
  ) {
    act(() => {
      this.opts.onServerResponse?.({ id, ...response });
    });
  }
}

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
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
  }),
);

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
  jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({
    event: {
      type: "mcp_servers",
      sessionId: "jsonrpc-control",
      servers: [],
      legacy: {
        workspace: { path: "/tmp/workspace/.cowork/mcp-servers.json", exists: false },
        user: { path: "/tmp/home/.cowork/mcp-servers.json", exists: false },
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
    expectedInteraction: Record<string, unknown>;
    expectedResponse: Record<string, unknown>;
    answer: () => void;
  }) {
    const { socket, requestId, method, params, expectedInteraction, expectedResponse, answer } =
      args;
    const feedLengthBefore = useAppStore.getState().threadRuntimeById[threadId]?.feed.length ?? 0;
    const notificationCountBefore = useAppStore.getState().notifications.length;
    const responseCountBefore = socket.responses.length;

    socket.requestFromServer(requestId, method, params);
    await flushAsyncWork();
    await flushAsyncWork();

    expect(useAppStore.getState().interactionsByThread[threadId]).toContainEqual(
      expect.objectContaining(expectedInteraction),
    );
    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed ?? []).toHaveLength(
      feedLengthBefore,
    );
    expect(useAppStore.getState().notifications).toHaveLength(notificationCountBefore);

    await act(async () => {
      answer();
      await Promise.resolve();
    });

    expect(socket.responses.slice(responseCountBefore)).toEqual([
      { id: requestId, result: expectedResponse },
    ]);
    expect(
      useAppStore
        .getState()
        .interactionsByThread[threadId]?.find((interaction) => interaction.requestId === requestId)
        ?.status,
    ).toBe("responding");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed ?? []).toHaveLength(
      feedLengthBefore,
    );
    expect(useAppStore.getState().notifications).toHaveLength(notificationCountBefore);
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
          (
            dom.window.HTMLElement.prototype as {
              attachEvent?: (name: string, handler: unknown) => void;
            }
          ).attachEvent = () => {};
        }
        if (typeof dom.window.HTMLElement.prototype.detachEvent !== "function") {
          (
            dom.window.HTMLElement.prototype as {
              detachEvent?: (name: string, handler: unknown) => void;
            }
          ).detachEvent = () => {};
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
            pluginMutationPendingKeys: {},
            pluginMutationError: null,
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
        interactionsByThread: {},
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
    expect(
      runtime?.feed.some(
        (item) =>
          "text" in item &&
          typeof item.text === "string" &&
          item.text.includes("Hello from JSON-RPC"),
      ),
    ).toBe(true);
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

    const reasoningOnlyFeed =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter(
          (item) => item.kind === "reasoning" || item.kind === "message",
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

    const feed =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter(
          (item) => item.kind === "reasoning" || item.kind === "message",
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

  test("shared JSON-RPC turn completion clears blank reasoning placeholders", async () => {
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
    socket.notify("item/completed", {
      threadId: sessionId,
      turnId: "turn-1",
      item: {
        id: "reasoning-1",
        type: "reasoning",
        mode: "summary",
        text: "",
      },
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
    const visibleKinds =
      runtime?.feed
        .filter((item) => item.kind === "reasoning" || item.kind === "message")
        .map((item) => item.kind) ?? [];
    expect(visibleKinds).toEqual(["message"]);
    expect(runtime?.feed).toContainEqual(
      expect.objectContaining({
        kind: "message",
        role: "assistant",
        text: "Final answer",
      }),
    );
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

    const tools =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter((item) => item.kind === "tool") ?? [];
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

    const feed =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter(
          (item) => item.kind === "reasoning" || item.kind === "message",
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

    const feed =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter(
          (item) => item.kind === "reasoning" || item.kind === "tool" || item.kind === "message",
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

    const liveFeed =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter(
          (item) => item.kind === "reasoning" || item.kind === "tool" || item.kind === "message",
        ) ?? [];
    expect(liveFeed.map((item) => item.kind)).toEqual([
      "message",
      "reasoning",
      "tool",
      "message",
      "tool",
      "message",
    ]);
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

    const completedFeed =
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.filter(
          (item) => item.kind === "reasoning" || item.kind === "tool" || item.kind === "message",
        ) ?? [];
    expect(completedFeed.map((item) => item.kind)).toEqual([
      "message",
      "reasoning",
      "tool",
      "message",
      "tool",
      "message",
    ]);
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
        uploadsDirectory: "/tmp/workspace/Custom Uploads",
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
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.title).toBe(
      "Renamed over JSON-RPC",
    );
    expect(runtime?.config?.model).toBe("gpt-5.4-mini");
    expect(runtime?.config?.uploadsDirectory).toBe("/tmp/workspace/Custom Uploads");
    expect(runtime?.enableMcp).toBe(false);
    expect(runtime?.sessionConfig?.preferredChildModel).toBe("gpt-5.4-mini");
  });

  test("shared JSON-RPC notifications map remaining live thread events", async () => {
    const socket = await reconnectThreadAndGetSocket();

    RUNTIME.pendingThreadSteers.set(
      threadId,
      new Map([
        [
          "steer-1",
          {
            clientMessageId: "steer-1",
            text: "tighten scope",
            expectedTurnId: "turn-1",
            accepted: false,
          },
        ],
      ]),
    );
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
      agents: [
        {
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
        },
      ],
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
    expect(state.latestTodosByThreadId[threadId]).toEqual([
      { content: "Ship the fix", status: "pending", activeForm: "" },
    ]);
    expect(runtime?.feed.some((item) => item.kind === "log" && item.line === "live log line")).toBe(
      true,
    );
    expect(runtime?.feed.some((item) => item.kind === "error" && item.message === "boom")).toBe(
      true,
    );
    expect(
      state.notifications.some((entry) => entry.detail === "session/internal_error: boom"),
    ).toBe(true);
  });

  test("a dropped accepted steer fails the exact desktop submission for retry", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const key = composerDraftKeyForThread(threadId);
    const originalSendMessage = useAppStore.getState().sendMessage;
    try {
      act(() => {
        useAppStore.setState((state) => ({
          composerDraftsByKey: {
            ...state.composerDraftsByKey,
            [key]: {
              ...createEmptyComposerDraft("2026-01-01T00:00:00.000Z"),
              revision: 7,
              text: "guidance that must remain retryable",
            },
          },
          threadRuntimeById: {
            ...state.threadRuntimeById,
            [threadId]: {
              ...state.threadRuntimeById[threadId]!,
              busy: true,
              activeTurnId: "turn-1",
            },
          },
          sendMessage: mock(async () => true),
        }));
      });

      let submitted = false;
      act(() => {
        submitted = useAppStore.getState().submitComposerDraft({ kind: "thread", threadId });
      });
      expect(submitted).toBe(true);
      await flushAsyncWork();
      const submission = useAppStore.getState().composerSubmissionsByKey[key];
      expect(submission?.phase).toBe("sending");
      if (!submission) throw new Error("missing composer submission");

      act(() => {
        useAppStore.setState((state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            [threadId]: {
              ...state.threadRuntimeById[threadId]!,
              pendingSteer: {
                clientMessageId: submission.clientMessageId,
                text: submission.prepared?.text ?? submission.draft.text,
                submissionId: submission.id,
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
        text: submission.prepared?.text ?? submission.draft.text,
        clientMessageId: submission.clientMessageId,
        steerRequestId: "steer-request-1",
      });
      await flushAsyncWork();
      expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
        id: submission.id,
        phase: "accepted",
        draft: { revision: 7, text: "guidance that must remain retryable" },
      });

      socket.notify("item/completed", {
        threadId: sessionId,
        turnId: "turn-1",
        item: {
          id: "dropped-steer-error",
          type: "error",
          source: "session",
          code: "validation_failed",
          message: "Active turn ended before pending steers could be accepted.",
          clientMessageId: submission.clientMessageId,
          steerRequestId: "steer-request-1",
        },
      });
      await flushAsyncWork();

      expect(useAppStore.getState().composerSubmissionsByKey[key]).toMatchObject({
        id: submission.id,
        phase: "failed",
        error: "Active turn ended before pending steers could be accepted.",
        draft: { revision: 7, text: "guidance that must remain retryable" },
      });
      expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingSteer).toBeNull();
    } finally {
      act(() => {
        useAppStore.setState({ sendMessage: originalSendMessage });
      });
    }
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
      expectedInteraction: {
        kind: "ask",
        requestId: "ask-1",
        question: "Continue?",
        options: ["Yes", "No"],
        status: "pending",
      },
      expectedResponse: { answer: "Yes" },
      answer: () => useAppStore.getState().answerAsk(threadId, "ask-1", "Yes"),
    });
  });

  test("queues attributable asks and approvals per thread without overwriting or replay duplicates", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const otherThreadId = `thread-${crypto.randomUUID()}`;
    const otherSessionId = `session-${crypto.randomUUID()}`;
    act(() => {
      useAppStore.setState((state) => ({
        threads: [
          ...state.threads,
          {
            id: otherThreadId,
            workspaceId,
            title: "Other prompt thread",
            titleSource: "manual",
            createdAt: "2024-01-01T00:00:03.000Z",
            lastMessageAt: "2024-01-01T00:00:03.000Z",
            status: "active",
            sessionId: otherSessionId,
            messageCount: 0,
            lastEventSeq: 0,
          },
        ],
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [otherThreadId]: {
            ...defaultThreadRuntime(),
            connected: true,
            wsUrl: "ws://mock",
            sessionId: otherSessionId,
          },
        },
      }));
    });

    socket.requestFromServer("ask-current", "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "Question for current chat?",
    });
    socket.requestFromServer("approval-other", "item/commandExecution/requestApproval", {
      threadId: otherSessionId,
      command: "rm -rf build",
      dangerous: true,
      reason: "requires_manual_review",
    });
    socket.requestFromServer("ask-other", "item/tool/requestUserInput", {
      threadId: otherSessionId,
      question: "Question for other chat?",
    });
    socket.requestFromServer("ask-current", "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "Question for current chat?",
    });
    await flushAsyncWork();

    const interactions = useAppStore.getState().interactionsByThread;
    expect(interactions[threadId]).toHaveLength(1);
    expect(interactions[threadId]?.[0]).toMatchObject({
      kind: "ask",
      requestId: "ask-current",
      status: "pending",
    });
    expect(interactions[otherThreadId]).toEqual([
      expect.objectContaining({
        kind: "approval",
        requestId: "approval-other",
        approvalKind: "manual",
        status: "pending",
      }),
      expect.objectContaining({
        kind: "ask",
        requestId: "ask-other",
        status: "pending",
      }),
    ]);

    await act(async () => {
      await useAppStore.getState().archiveThread(otherThreadId);
    });
    expect(useAppStore.getState().interactionsByThread[otherThreadId]).toHaveLength(2);

    await act(async () => {
      await useAppStore.getState().removeThread(otherThreadId);
    });
    expect(useAppStore.getState().interactionsByThread[otherThreadId]).toBeUndefined();
  });

  test("keeps sibling interactions, suppresses duplicate responses, and retains failed responses for retry", async () => {
    const socket = await reconnectThreadAndGetSocket();
    socket.requestFromServer("ask-first", "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "First question?",
    });
    socket.requestFromServer("sandbox-second", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
      category: "network",
    });
    await flushAsyncWork();

    let firstAnswerAccepted = false;
    let duplicateAnswerAccepted = false;
    act(() => {
      firstAnswerAccepted = useAppStore.getState().answerAsk(threadId, "ask-first", "Answer");
      duplicateAnswerAccepted = useAppStore
        .getState()
        .answerAsk(threadId, "ask-first", "Duplicate");
    });
    expect(firstAnswerAccepted).toBe(true);
    expect(duplicateAnswerAccepted).toBe(false);
    expect(socket.responses.filter((response) => response.id === "ask-first")).toEqual([
      { id: "ask-first", result: { answer: "Answer" } },
    ]);
    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({ requestId: "ask-first", status: "responding" }),
      expect.objectContaining({ requestId: "sandbox-second", status: "pending" }),
    ]);

    socket.notify("serverRequest/resolved", { threadId: sessionId, requestId: "ask-first" });
    await flushAsyncWork();
    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({ requestId: "ask-first", status: "resolved" }),
      expect.objectContaining({ requestId: "sandbox-second", status: "pending" }),
    ]);

    act(() => {
      RUNTIME.jsonRpcSockets.delete(workspaceId);
    });
    let disconnectedAnswerAccepted = true;
    act(() => {
      disconnectedAnswerAccepted = useAppStore
        .getState()
        .answerApproval(threadId, "sandbox-second", true);
    });
    expect(disconnectedAnswerAccepted).toBe(false);
    expect(useAppStore.getState().interactionsByThread[threadId]?.[1]).toMatchObject({
      requestId: "sandbox-second",
      status: "failed",
      response: true,
    });

    let retryAccepted = false;
    act(() => {
      RUNTIME.jsonRpcSockets.set(workspaceId, socket as never);
      retryAccepted = useAppStore.getState().retryInteractionResponse(threadId, "sandbox-second");
    });
    expect(retryAccepted).toBe(true);
    expect(socket.responses.filter((response) => response.id === "sandbox-second")).toEqual([
      { id: "sandbox-second", result: { decision: "accept" } },
    ]);
    expect(useAppStore.getState().interactionsByThread[threadId]?.[1]).toMatchObject({
      requestId: "sandbox-second",
      status: "responding",
      response: true,
    });
  });

  test("routes a response conflict to the exact responding interaction and keeps retry visible", async () => {
    const socket = await reconnectThreadAndGetSocket();
    socket.requestFromServer("ask-conflict", "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "Which response should commit?",
    });
    socket.requestFromServer("approval-sibling", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "bun run check",
      dangerous: false,
      reason: "requires_manual_review",
    });
    await flushAsyncWork();

    act(() => {
      expect(useAppStore.getState().answerAsk(threadId, "ask-conflict", "First")).toBe(true);
    });
    socket.respondFromServer("ask-conflict", {
      error: {
        code: -32602,
        message: "Conflicting response for resolved interaction: ask-conflict",
        data: {
          category: "interaction_response_conflict",
          requestId: "ask-conflict",
          threadId: sessionId,
        },
      },
    });
    await flushAsyncWork();

    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({
        requestId: "ask-conflict",
        status: "failed",
        error: "Conflicting response for resolved interaction: ask-conflict",
      }),
      expect.objectContaining({
        requestId: "approval-sibling",
        status: "pending",
      }),
    ]);
    expect(harness?.dom.window.document.body.textContent).toContain(
      "Conflicting response for resolved interaction: ask-conflict",
    );
    expect(harness?.dom.window.document.body.textContent).toContain("Retry");

    act(() => {
      expect(useAppStore.getState().retryInteractionResponse(threadId, "ask-conflict")).toBe(true);
    });
    socket.notify("serverRequest/resolved", {
      threadId: sessionId,
      requestId: "ask-conflict",
      response: { kind: "ask", answer: "First" },
    });
    await flushAsyncWork();
    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({ requestId: "ask-conflict", status: "resolved" }),
      expect.objectContaining({ requestId: "approval-sibling", status: "pending" }),
    ]);
  });

  test("expires every outstanding interaction when its turn ends", async () => {
    const socket = await reconnectThreadAndGetSocket();
    socket.requestFromServer("ask-expiring", "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "This question will expire.",
    });
    socket.requestFromServer("approval-expiring", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "bun run check",
      reason: "requires_manual_review",
    });
    await flushAsyncWork();

    socket.notify("turn/completed", {
      threadId: sessionId,
      turn: { id: "turn-expiring", status: "interrupted" },
    });
    await flushAsyncWork();

    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({ requestId: "ask-expiring", status: "resolved" }),
      expect.objectContaining({ requestId: "approval-expiring", status: "resolved" }),
    ]);
  });

  test("reconnect replay preserves a failed response for one-click retry without duplicating it", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "ask-reconnect-retry";
    socket.requestFromServer(requestId, "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "Retry after reconnect?",
    });
    await flushAsyncWork();

    await act(async () => {
      expect(useAppStore.getState().answerAsk(threadId, requestId, "Yes")).toBe(true);
      socket.close();
      await Promise.resolve();
    });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "failed",
      response: "Yes",
    });

    socket.requestFromServer(requestId, "item/tool/requestUserInput", {
      threadId: sessionId,
      question: "Retry after reconnect?",
    });
    await flushAsyncWork();
    expect(useAppStore.getState().interactionsByThread[threadId]).toHaveLength(1);
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "failed",
      response: "Yes",
    });

    let retryAccepted = false;
    act(() => {
      RUNTIME.jsonRpcSockets.set(workspaceId, socket as never);
      retryAccepted = useAppStore.getState().retryInteractionResponse(threadId, requestId);
    });
    expect(retryAccepted).toBe(true);
    expect(socket.responses.filter((response) => response.id === requestId)).toEqual([
      { id: requestId, result: { answer: "Yes" } },
      { id: requestId, result: { answer: "Yes" } },
    ]);
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "responding",
      response: "Yes",
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
      expectedInteraction: {
        kind: "approval",
        approvalKind: "manual",
        requestId: "approval-1",
        command: "rm -rf build",
        dangerous: true,
        reasonCode: "requires_manual_review",
        status: "pending",
      },
      expectedResponse: { decision: "accept" },
      answer: () => useAppStore.getState().answerApproval(threadId, "approval-1", true),
    });
  });

  test("sandbox-denied escalation renders inline in the feed, not the modal", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-approval-1";
    const responseCountBefore = socket.responses.length;

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
      detail: "The OS sandbox blocked network access for this command.",
      category: "network",
    });
    await flushAsyncWork();
    await flushAsyncWork();

    const pending = useAppStore.getState().interactionsByThread[threadId] ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: "approval",
      approvalKind: "sandbox",
      requestId,
      command: "curl https://example.com",
      detail: "The OS sandbox blocked network access for this command.",
      category: "network",
      status: "pending",
    });
    // The card actually renders inline in the live ChatView tree (not just store state).
    const bodyText = harness?.dom.window.document.body.textContent ?? "";
    expect(bodyText).toContain("Sandbox blocked");
    expect(bodyText).toContain("curl https://example.com");

    await act(async () => {
      useAppStore.getState().answerApproval(threadId, requestId, true);
      await Promise.resolve();
    });

    // Answering responds once and leaves the interaction in-flight until the server confirms it.
    expect(socket.responses.slice(responseCountBefore)).toEqual([
      { id: requestId, result: { decision: "accept" } },
    ]);
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "responding",
      response: true,
    });
  });

  test("sandbox-denied escalation stays visible and answerable after switching threads", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-approval-off-thread";
    const otherThreadId = `thread-${crypto.randomUUID()}`;
    const otherSessionId = `session-${crypto.randomUUID()}`;

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com/off-thread",
      dangerous: true,
      reason: "sandbox_denied_escalation",
      detail: "The OS sandbox blocked network access for this command.",
      category: "network",
    });
    await flushAsyncWork();

    act(() => {
      useAppStore.setState((state) => ({
        selectedThreadId: otherThreadId,
        threads: [
          ...state.threads,
          {
            id: otherThreadId,
            workspaceId,
            title: "Other thread",
            titleSource: "manual",
            createdAt: "2024-01-01T00:00:03.000Z",
            lastMessageAt: "2024-01-01T00:00:03.000Z",
            status: "disconnected",
            sessionId: otherSessionId,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            legacyTranscriptId: null,
          },
        ],
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [otherThreadId]: {
            ...defaultThreadRuntime(),
            wsUrl: "ws://mock",
            sessionId: otherSessionId,
          },
        },
      }));
    });
    await flushAsyncWork();

    const body = harness?.dom.window.document.body;
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "pending",
    });
    expect(body?.textContent ?? "").toContain("curl https://example.com/off-thread");
    const keepBlockedButton = Array.from(body?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Keep blocked"),
    );
    expect(keepBlockedButton).toBeDefined();
    if (!harness) {
      throw new Error("missing jsdom harness");
    }

    await act(async () => {
      keepBlockedButton?.dispatchEvent(
        new harness.dom.window.MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(socket.responses).toContainEqual({ id: requestId, result: { decision: "decline" } });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "responding",
      response: false,
    });
  });

  test("sandbox and manual approvals coexist in arrival order", async () => {
    const socket = await reconnectThreadAndGetSocket();
    socket.requestFromServer("ordinary-approval", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "rm -rf build",
      dangerous: true,
      reason: "requires_manual_review",
    });
    socket.requestFromServer("sandbox-clears-modal", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({
        requestId: "ordinary-approval",
        approvalKind: "manual",
        status: "pending",
      }),
      expect.objectContaining({
        requestId: "sandbox-clears-modal",
        approvalKind: "sandbox",
        status: "pending",
      }),
    ]);
  });

  test("answering a sandbox approval leaves a sibling manual approval pending", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-unrelated-modal";
    socket.requestFromServer("ordinary-approval", "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "rm -rf build",
      dangerous: true,
      reason: "requires_manual_review",
    });
    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    await act(async () => {
      useAppStore.getState().answerApproval(threadId, requestId, false);
      await Promise.resolve();
    });

    expect(useAppStore.getState().interactionsByThread[threadId]).toEqual([
      expect.objectContaining({ requestId: "ordinary-approval", status: "pending" }),
      expect.objectContaining({ requestId, status: "responding", response: false }),
    ]);
  });

  test("dismissPrompt declines the latest inline sandbox approval", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-escape-denies";

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).toContainEqual({ id: requestId, result: { decision: "decline" } });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "responding",
      response: false,
    });
  });

  test("dismissPrompt declines an off-thread inline sandbox approval", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-escape-off-thread-denies";

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    act(() => {
      useAppStore.setState({ selectedThreadId: `thread-${crypto.randomUUID()}` });
    });

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).toContainEqual({ id: requestId, result: { decision: "decline" } });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "responding",
      response: false,
    });
  });

  test("dismissPrompt does not act on task-owned approvals from ordinary chat", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-task-approval-stays-scoped";
    const chatThreadId = `thread-${crypto.randomUUID()}`;

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    act(() => {
      useAppStore.setState((state) => ({
        view: "chat",
        selectedTaskId: null,
        selectedThreadId: chatThreadId,
        threads: [
          ...state.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, taskId: "task-1", taskThreadId: "task-thread-1" }
              : thread,
          ),
          {
            id: chatThreadId,
            workspaceId,
            title: "Ordinary chat",
            createdAt: "2024-01-01T00:00:03.000Z",
            lastMessageAt: "2024-01-01T00:00:03.000Z",
            status: "active",
            sessionId: `session-${crypto.randomUUID()}`,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
          },
        ],
        tasksById: {
          "task-1": {
            id: "task-1",
            threads: [
              {
                id: "task-thread-1",
                taskId: "task-1",
                sessionId: threadId,
              },
            ],
          },
        } as never,
      }));
    });

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).not.toContainEqual({
      id: requestId,
      result: { decision: "decline" },
    });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "pending",
    });
  });

  test("dismissPrompt declines selected task approvals while settings overlays task", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-settings-over-task-denies";

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com/settings-task",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    act(() => {
      useAppStore.setState((state) => ({
        view: "settings",
        lastNonSettingsView: "task",
        selectedTaskId: "task-1",
        selectedThreadId: threadId,
        threads: state.threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, taskId: "task-1", taskThreadId: "task-thread-1" }
            : thread,
        ),
        tasksById: {
          "task-1": {
            id: "task-1",
            status: "working",
            threads: [
              {
                id: "task-thread-1",
                taskId: "task-1",
                sessionId: threadId,
              },
            ],
          },
        } as never,
      }));
    });

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).toContainEqual({ id: requestId, result: { decision: "decline" } });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "responding",
      response: false,
    });
  });

  test("dismissPrompt keeps task approvals hidden while settings overlays chat", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-settings-over-chat-stays-scoped";
    const chatThreadId = `thread-${crypto.randomUUID()}`;

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com/settings-chat",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    act(() => {
      useAppStore.setState((state) => ({
        view: "settings",
        lastNonSettingsView: "chat",
        selectedTaskId: null,
        selectedThreadId: chatThreadId,
        threads: [
          ...state.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, taskId: "task-1", taskThreadId: "task-thread-1" }
              : thread,
          ),
          {
            id: chatThreadId,
            workspaceId,
            title: "Ordinary chat",
            createdAt: "2024-01-01T00:00:03.000Z",
            lastMessageAt: "2024-01-01T00:00:03.000Z",
            status: "active",
            sessionId: `session-${crypto.randomUUID()}`,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
          },
        ],
        tasksById: {
          "task-1": {
            id: "task-1",
            status: "working",
            threads: [
              {
                id: "task-thread-1",
                taskId: "task-1",
                sessionId: threadId,
              },
            ],
          },
        } as never,
      }));
    });

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).not.toContainEqual({
      id: requestId,
      result: { decision: "decline" },
    });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "pending",
    });
  });

  for (const status of ["completed", "cancelled", "failed"] as const) {
    test(`dismissPrompt declines pending sandbox approvals on ${status} task threads`, async () => {
      const socket = await reconnectThreadAndGetSocket();
      const requestId = `sandbox-terminal-task-${status}`;

      socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
        threadId: sessionId,
        turnId: "turn-1",
        itemId: "item-sandbox",
        command: `curl https://example.com/${status}`,
        dangerous: true,
        reason: "sandbox_denied_escalation",
      });
      await flushAsyncWork();

      act(() => {
        useAppStore.setState((state) => ({
          view: "task",
          selectedTaskId: "task-1",
          selectedThreadId: threadId,
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, taskId: "task-1", taskThreadId: "task-thread-1" }
              : thread,
          ),
          tasksById: {
            "task-1": {
              id: "task-1",
              status,
              threads: [
                {
                  id: "task-thread-1",
                  taskId: "task-1",
                  sessionId: threadId,
                },
              ],
            },
          } as never,
        }));
      });

      await act(async () => {
        useAppStore.getState().dismissPrompt();
        await Promise.resolve();
      });

      expect(socket.responses).toContainEqual({ id: requestId, result: { decision: "decline" } });
      expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
        requestId,
        status: "responding",
        response: false,
      });
    });
  }

  test("dismissPrompt keeps terminal task approvals scoped out of chat and other tasks", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-terminal-task-stays-scoped";
    const chatThreadId = `thread-${crypto.randomUUID()}`;
    const otherTaskThreadId = `thread-${crypto.randomUUID()}`;

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com/task-only",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    act(() => {
      useAppStore.setState((state) => ({
        view: "chat",
        selectedTaskId: null,
        selectedThreadId: chatThreadId,
        threads: [
          ...state.threads.map((thread) =>
            thread.id === threadId
              ? { ...thread, taskId: "task-1", taskThreadId: "task-thread-1" }
              : thread,
          ),
          {
            id: chatThreadId,
            workspaceId,
            title: "Ordinary chat",
            createdAt: "2024-01-01T00:00:03.000Z",
            lastMessageAt: "2024-01-01T00:00:03.000Z",
            status: "active",
            sessionId: `session-${crypto.randomUUID()}`,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
          },
          {
            id: otherTaskThreadId,
            workspaceId,
            title: "Other task thread",
            createdAt: "2024-01-01T00:00:04.000Z",
            lastMessageAt: "2024-01-01T00:00:04.000Z",
            status: "active",
            sessionId: `session-${crypto.randomUUID()}`,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            taskId: "task-2",
            taskThreadId: "task-thread-2",
          },
        ],
        tasksById: {
          "task-1": {
            id: "task-1",
            status: "completed",
            threads: [
              {
                id: "task-thread-1",
                taskId: "task-1",
                sessionId: threadId,
              },
            ],
          },
          "task-2": {
            id: "task-2",
            status: "working",
            threads: [
              {
                id: "task-thread-2",
                taskId: "task-2",
                sessionId: otherTaskThreadId,
              },
            ],
          },
        } as never,
      }));
    });

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).not.toContainEqual({
      id: requestId,
      result: { decision: "decline" },
    });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "pending",
    });

    act(() => {
      useAppStore.setState({
        view: "task",
        selectedTaskId: "task-2",
        selectedThreadId: otherTaskThreadId,
      } as never);
    });

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).not.toContainEqual({
      id: requestId,
      result: { decision: "decline" },
    });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "pending",
    });
  });

  test("dismissPrompt declines the latest off-thread inline sandbox approval", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const firstRequestId = "sandbox-escape-first-off-thread";
    const latestRequestId = "sandbox-escape-latest-off-thread";
    const selectedIdleThreadId = `thread-${crypto.randomUUID()}`;
    const selectedIdleSessionId = `session-${crypto.randomUUID()}`;
    const latestThreadId = `thread-${crypto.randomUUID()}`;
    const latestSessionId = `session-${crypto.randomUUID()}`;

    act(() => {
      useAppStore.setState((state) => ({
        selectedThreadId: selectedIdleThreadId,
        threads: [
          ...state.threads,
          {
            id: selectedIdleThreadId,
            workspaceId,
            title: "Selected idle thread",
            titleSource: "manual",
            createdAt: "2024-01-01T00:00:03.000Z",
            lastMessageAt: "2024-01-01T00:00:03.000Z",
            status: "disconnected",
            sessionId: selectedIdleSessionId,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            legacyTranscriptId: null,
          },
          {
            id: latestThreadId,
            workspaceId,
            title: "Latest prompt thread",
            titleSource: "manual",
            createdAt: "2024-01-01T00:00:04.000Z",
            lastMessageAt: "2024-01-01T00:00:04.000Z",
            status: "disconnected",
            sessionId: latestSessionId,
            messageCount: 0,
            lastEventSeq: 0,
            draft: false,
            legacyTranscriptId: null,
          },
        ],
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [selectedIdleThreadId]: {
            ...defaultThreadRuntime(),
            wsUrl: "ws://mock",
            sessionId: selectedIdleSessionId,
          },
          [latestThreadId]: {
            ...defaultThreadRuntime(),
            wsUrl: "ws://mock",
            sessionId: latestSessionId,
          },
        },
      }));
    });

    socket.requestFromServer(firstRequestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox-first",
      command: "curl https://example.com/first",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    socket.requestFromServer(latestRequestId, "item/commandExecution/requestApproval", {
      threadId: latestSessionId,
      turnId: "turn-2",
      itemId: "item-sandbox-latest",
      command: "curl https://example.com/latest",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();

    await act(async () => {
      useAppStore.getState().dismissPrompt();
      await Promise.resolve();
    });

    expect(socket.responses).toContainEqual({
      id: latestRequestId,
      result: { decision: "decline" },
    });
    expect(socket.responses).not.toContainEqual({
      id: firstRequestId,
      result: { decision: "decline" },
    });
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId: firstRequestId,
      status: "pending",
    });
    expect(useAppStore.getState().interactionsByThread[latestThreadId]?.[0]).toMatchObject({
      requestId: latestRequestId,
      status: "responding",
      response: false,
    });
  });

  test("sandbox approval stays visible when the response cannot be sent", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-approval-send-fails";

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
      detail: "The OS sandbox blocked network access for this command.",
      category: "network",
    });
    await flushAsyncWork();

    act(() => {
      RUNTIME.jsonRpcSockets.delete(workspaceId);
      useAppStore.setState((state) => ({
        workspaceRuntimeById: {
          ...state.workspaceRuntimeById,
          [workspaceId]: {
            ...state.workspaceRuntimeById[workspaceId],
            serverUrl: null,
          },
        },
      }));
    });

    await act(async () => {
      useAppStore.getState().answerApproval(threadId, requestId, true);
      await Promise.resolve();
    });

    expect(socket.responses).toEqual([]);
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "failed",
      response: true,
    });
  });

  test("resolved server requests clear replayed inline sandbox approvals", async () => {
    const socket = await reconnectThreadAndGetSocket();
    const requestId = "sandbox-approval-replayed";

    socket.requestFromServer(requestId, "item/commandExecution/requestApproval", {
      threadId: sessionId,
      turnId: "turn-1",
      itemId: "item-sandbox",
      command: "curl https://example.com",
      dangerous: true,
      reason: "sandbox_denied_escalation",
    });
    await flushAsyncWork();
    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "pending",
    });

    socket.notify("serverRequest/resolved", { threadId: sessionId, requestId });
    await flushAsyncWork();

    expect(useAppStore.getState().interactionsByThread[threadId]?.[0]).toMatchObject({
      requestId,
      status: "resolved",
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

    expect(
      useAppStore
        .getState()
        .interactionsByThread[threadId]?.some(
          (interaction) => interaction.requestId === "ask-stale",
        ) ?? false,
    ).toBe(false);
    expect(firstSocket.responses).toEqual([]);
    expect(secondSocket.responses).toEqual([]);
    expect(
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.some(
          (item) => item.kind === "log" && item.line === "stale retired log line",
        ),
    ).toBe(false);

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

    expect(
      useAppStore
        .getState()
        .threadRuntimeById[threadId]?.feed.some(
          (item) => item.kind === "log" && item.line === "fresh replacement log line",
        ),
    ).toBe(true);

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
      expectedInteraction: {
        kind: "ask",
        requestId: "ask-fresh",
        question: "Continue on replacement?",
        options: ["Yes", "No"],
        status: "pending",
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

    const turnStartParams = jsonRpcRequests.find((entry) => entry.method === "turn/start")
      ?.params as { clientMessageId?: string } | undefined;
    expect(turnStartParams?.clientMessageId).toEqual(expect.any(String));
    expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingTurnStart).toMatchObject({
      clientMessageId: turnStartParams?.clientMessageId,
      text: "hello once",
      status: "sending",
    });

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
    expect(runtime?.pendingTurnStart).toBeNull();
    const userMessages =
      runtime?.feed.filter((item) => item.kind === "message" && item.role === "user") ?? [];
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toMatchObject({
      id: turnStartParams?.clientMessageId,
      text: "hello once",
    });
  });
});
