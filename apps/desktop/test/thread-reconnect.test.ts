import { beforeEach as resetNavigationBeforeEach } from "bun:test";
import { appNavigation } from "../src/app/navigation";
import { setAppState } from "./helpers/navigation";

resetNavigationBeforeEach(() =>
  appNavigation.update({ view: "chat", settingsPage: "models", lastNonSettingsView: "chat" }, true),
);

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { composerDraftKeyForThread, createEmptyComposerDraft } from "../src/app/composerDrafts";
import { operationKey } from "../src/app/store.helpers/operations";
import { shouldShowReconnectBanner } from "../src/ui/chat/chatLogic";
import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: any) => any | Promise<any>>();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  static deferClose = false;
  readonly readyPromise = Promise.resolve();
  closed = false;
  private closeDeferred = false;

  constructor(
    public readonly opts: {
      onOpen?: () => void;
      onClose?: () => void;
      onReconnecting?: (event: unknown) => void;
      onReconnectExhausted?: (reason: string) => void;
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

  respond() {
    return true;
  }

  close() {
    this.closed = true;
    if (MockJsonRpcSocket.deferClose) {
      this.closeDeferred = true;
      return;
    }
    this.opts.onClose?.();
  }

  emitDeferredClose() {
    if (!this.closeDeferred) return;
    this.closeDeferred = false;
    this.opts.onClose?.();
  }

  reopen() {
    this.opts.onOpen?.();
  }

  reconnecting() {
    this.opts.onReconnecting?.({
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      reason: "websocket closed",
      queuedOperationCount: 1,
      pendingRequestCount: 1,
    });
  }

  reconnectExhausted() {
    this.opts.onReconnectExhausted?.("Reconnect attempts exhausted.");
  }
}

const readTranscriptCalls: string[] = [];
const deleteTranscriptCalls: string[] = [];

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

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    appendTranscriptBatch: async () => {},
    appendTranscriptEvent: async () => {},
    deleteTranscript: async ({ threadId }: { threadId: string }) => {
      deleteTranscriptCalls.push(threadId);
    },
    listDirectory: async () => [],
    loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
    pickWorkspaceDirectory: async () => null,
    readTranscript: async ({ threadId }: { threadId: string }) => {
      readTranscriptCalls.push(threadId);
      return [
        {
          ts: "2024-01-01T00:00:02.000Z",
          threadId,
          direction: "server",
          payload: { type: "assistant_message", text: "Transcript fallback reply" },
        },
      ];
    },
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
const { hydrateThreadSelection } = await import("../src/app/store.actions/thread");
const { RUNTIME, defaultThreadRuntime } = await import("../src/app/store.helpers");

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferredRequest() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installWindowMock(value: Record<string, unknown>) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

function restoreWindowMock() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>).window;
}

function canonicalThreadId(sessionId: string, fallbackThreadId?: string): string {
  const state = useAppStore.getState();
  const thread = state.threads.find(
    (item) =>
      item.id === sessionId ||
      item.sessionId === sessionId ||
      (fallbackThreadId ? item.legacyTranscriptId === fallbackThreadId : false),
  );
  return thread?.id ?? state.selectedThreadId ?? fallbackThreadId ?? sessionId;
}

function threadMeta(sessionId: string) {
  return {
    id: sessionId,
    title: "Harness Thread",
    modelProvider: "openai",
    model: "gpt-5.2",
    cwd: "/tmp/workspace",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:02.000Z",
    status: { type: "loaded" },
  };
}

function threadSnapshot(sessionId: string) {
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
  };
}

function setDefaultJsonRpcHandlers(sessionId = "session-1") {
  jsonRpcHandlers.set("thread/list", async () => ({
    threads: [threadMeta(sessionId)],
  }));
  jsonRpcHandlers.set("thread/resume", async () => ({
    thread: threadMeta(sessionId),
  }));
  jsonRpcHandlers.set("thread/start", async () => ({
    thread: threadMeta(sessionId),
  }));
  jsonRpcHandlers.set("thread/read", async () => ({
    coworkSnapshot: threadSnapshot(sessionId),
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
    event: {
      type: "provider_auth_methods",
      sessionId: "jsonrpc-control",
      methods: {},
    },
  }));
  jsonRpcHandlers.set("cowork/provider/status/refresh", async () => ({
    event: {
      type: "provider_status",
      sessionId: "jsonrpc-control",
      providers: [],
    },
  }));
  jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({
    event: {
      type: "mcp_servers",
      sessionId: "jsonrpc-control",
      servers: [],
      legacy: {
        workspace: { path: "/tmp/workspace/.cowork/mcp-servers.json", exists: false },
        user: { path: "/home/test/.cowork/mcp-servers.json", exists: false },
      },
      files: [],
    },
  }));
  jsonRpcHandlers.set("cowork/memory/list", async () => ({
    event: {
      type: "memory_list",
      sessionId: "jsonrpc-control",
      memories: [],
    },
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
    event: {
      type: "skills_list",
      sessionId: "jsonrpc-control",
      skills: [],
    },
  }));
  jsonRpcHandlers.set("cowork/session/defaults/apply", async () => ({
    event: {
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
      },
    },
  }));
}

function seedStore(
  threadPatch: Record<string, unknown> = {},
  runtimePatch: Record<string, unknown> = {},
) {
  const workspaceId = `ws-${crypto.randomUUID()}`;
  const threadId = `thread-${crypto.randomUUID()}`;
  setAppState(useAppStore, {
    ready: true,
    startupError: null,
    navigation: { view: "chat" },
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        path: "/tmp/workspace",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastOpenedAt: "2024-01-01T00:00:00.000Z",
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
    threads: [
      {
        id: threadId,
        workspaceId,
        title: "Thread",
        titleSource: "manual",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastMessageAt: "2024-01-01T00:00:02.000Z",
        status: "disconnected",
        sessionId: "session-1",
        messageCount: 2,
        lastEventSeq: 4,
        draft: false,
        legacyTranscriptId: null,
        ...threadPatch,
      },
    ],
    selectedWorkspaceId: workspaceId,
    selectedThreadId: null,
    workspaceRuntimeById: {
      [workspaceId]: {
        serverUrl: "ws://mock",
        starting: false,
        error: null,
        controlSessionId: null,
        controlConfig: null,
        controlSessionConfig: null,
        controlEnableMcp: null,
        memories: [],
        memoriesLoading: false,
        mcpServers: [],
        mcpFiles: [],
        mcpWarnings: [],
        mcpValidationByName: {},
        mcpLastAuthChallenge: null,
        mcpLastAuthResult: null,
        skills: [],
        skillsCatalog: null,
        skillCatalogLoading: false,
        skillCatalogError: null,
        skillsMutationBlocked: false,
        skillsMutationBlockedReason: null,
        skillMutationPendingKeys: {},
        skillMutationError: null,
        selectedSkillName: null,
        selectedSkillContent: null,
        selectedSkillInstallationId: null,
        selectedSkillInstallation: null,
        selectedSkillPreview: null,
        skillUpdateChecksByInstallationId: {},
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
        sessionId: "session-1",
        wsUrl: "ws://mock",
        ...runtimePatch,
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
    perWorkspaceSettings: false,
  } as any);
  return { workspaceId, threadId };
}

describe("thread reconnect over shared JSON-RPC socket", () => {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    MockJsonRpcSocket.deferClose = false;
    readTranscriptCalls.length = 0;
    deleteTranscriptCalls.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.workspaceJsonRpcSocketGenerations.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.modelStreamByThread.clear();
    setDefaultJsonRpcHandlers();
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
    restoreWindowMock();
  });

  test.each(["rejected", "missing acknowledgement", "wrong session"])(
    "preserves local history and drafts when deletion returns %s",
    async (outcome) => {
      const feed = [
        {
          id: "answer",
          kind: "message",
          role: "assistant",
          ts: "2024-01-01T00:00:02.000Z",
          text: "Keep this answer",
        },
      ];
      const { threadId } = seedStore({}, { feed });
      setAppState(useAppStore, { selectedThreadId: threadId });
      useAppStore.getState().setComposerText("Keep this unsent draft");
      const draftKey = `thread:${threadId}`;
      const draft = useAppStore.getState().composerDraftsByKey[draftKey];
      jsonRpcHandlers.set("cowork/session/delete", async () => {
        if (outcome === "rejected") throw new Error("Delete denied");
        if (outcome === "missing acknowledgement") return {};
        return {
          event: {
            type: "session_deleted",
            sessionId: "control",
            targetSessionId: "different-session",
          },
        };
      });

      await useAppStore.getState().deleteThreadHistory(threadId);
      await flushAsyncWork();

      expect(useAppStore.getState().threads.some((thread) => thread.id === threadId)).toBe(true);
      expect(useAppStore.getState().threadRuntimeById[threadId]?.feed).toEqual(feed);
      expect(useAppStore.getState().composerDraftsByKey[draftKey]).toEqual(draft);
      expect(deleteTranscriptCalls).toEqual([]);
      expect(jsonRpcRequests.some((request) => request.method === "thread/unsubscribe")).toBe(
        false,
      );
      expect(useAppStore.getState().notifications).toContainEqual(
        expect.objectContaining({ kind: "error", title: "Delete session history failed" }),
      );
    },
  );

  test("removes local history only after the server confirms the matching deletion", async () => {
    const { threadId } = seedStore();
    setAppState(useAppStore, { selectedThreadId: threadId });
    useAppStore.getState().setComposerText("Discard after confirmation");
    const deletion = deferredRequest();
    jsonRpcHandlers.set("cowork/session/delete", () => deletion.promise);
    const pendingDelete = useAppStore.getState().deleteThreadHistory(threadId);
    await flushAsyncWork();
    expect(useAppStore.getState().threadRuntimeById[threadId]).toBeDefined();
    expect(useAppStore.getState().composerDraftsByKey[`thread:${threadId}`]).toBeDefined();

    deletion.resolve({
      event: { type: "session_deleted", sessionId: "control", targetSessionId: "session-1" },
    });
    await pendingDelete;

    expect(useAppStore.getState().threads.some((thread) => thread.id === threadId)).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[threadId]).toBeUndefined();
    expect(useAppStore.getState().composerDraftsByKey[`thread:${threadId}`]?.text ?? "").toBe("");
    expect(deleteTranscriptCalls).toContain("session-1");
  });

  test("removes a local-only draft without requesting server deletion", async () => {
    const { threadId } = seedStore({ draft: true, sessionId: null }, { sessionId: null });

    await useAppStore.getState().deleteThreadHistory(threadId);

    expect(useAppStore.getState().threads.some((thread) => thread.id === threadId)).toBe(false);
    expect(jsonRpcRequests.some((request) => request.method === "cowork/session/delete")).toBe(
      false,
    );
  });

  test.each(["model", "reasoning"])(
    "restores confirmed preferences and reports an asynchronous %s rejection",
    async (kind) => {
      const config = { provider: "openai", model: "gpt-5.2", workingDirectory: "/tmp/workspace" };
      const { threadId } = seedStore(
        { reasoningEffort: "high" },
        { composerReasoningEffort: "high", config },
      );
      const request = deferredRequest();
      const method = kind === "model" ? "cowork/session/model/set" : "cowork/session/config/set";
      jsonRpcHandlers.set(method, () => request.promise);

      if (kind === "model") useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4");
      else useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "low");
      const preferenceBeforeAcknowledgement = useAppStore
        .getState()
        .threads.find((thread) => thread.id === threadId)?.reasoningEffort;
      await flushAsyncWork();
      request.reject(new Error(`${kind} rejected asynchronously`));
      await flushAsyncWork();

      expect(jsonRpcRequests.some((entry) => entry.method === method)).toBe(true);
      expect(preferenceBeforeAcknowledgement).toBe("high");
      expect(
        useAppStore.getState().threads.find((thread) => thread.id === threadId)?.reasoningEffort,
      ).toBe("high");
      expect(useAppStore.getState().threadRuntimeById[threadId]).toMatchObject({
        composerReasoningEffort: "high",
        config,
      });
      expect(
        useAppStore
          .getState()
          .notifications.filter((notification) => notification.kind === "error"),
      ).toEqual([
        expect.objectContaining({
          detail: expect.stringContaining(`${kind} rejected asynchronously`),
        }),
      ]);
    },
  );

  test.each(["model", "reasoning"])(
    "commits a %s preference only after its request succeeds",
    async (kind) => {
      const { threadId } = seedStore(
        { reasoningEffort: "high" },
        { composerReasoningEffort: "high" },
      );
      const request = deferredRequest();
      const method = kind === "model" ? "cowork/session/model/set" : "cowork/session/config/set";
      jsonRpcHandlers.set(method, () => request.promise);
      if (kind === "model") useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4");
      else useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "low");
      const preferenceBeforeAcknowledgement = useAppStore
        .getState()
        .threads.find((thread) => thread.id === threadId)?.reasoningEffort;
      await flushAsyncWork();
      request.resolve({});
      await flushAsyncWork();

      expect(preferenceBeforeAcknowledgement).toBe("high");
      expect(
        useAppStore.getState().threads.find((thread) => thread.id === threadId)?.reasoningEffort,
      ).toBe(kind === "model" ? undefined : "low");
      expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBe(
        kind === "model" ? null : "low",
      );
    },
  );

  test.each(
    ["model", "reasoning"].flatMap((kind) => [
      { kind, outcome: "failure" },
      { kind, outcome: "success" },
    ]),
  )(
    "an older request cannot undo a newer confirmed reasoning choice (%j)",
    async ({ kind, outcome }) => {
      const { threadId } = seedStore(
        { reasoningEffort: "high" },
        { composerReasoningEffort: "high" },
      );
      const older = deferredRequest();
      const newer = deferredRequest();
      let configRequests = 0;
      jsonRpcHandlers.set("cowork/session/model/set", () => older.promise);
      jsonRpcHandlers.set("cowork/session/config/set", () =>
        kind === "reasoning" && configRequests++ === 0 ? older.promise : newer.promise,
      );
      if (kind === "model") useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4");
      else useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "low");
      useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "medium");
      await flushAsyncWork();
      newer.resolve({});
      await flushAsyncWork();
      if (outcome === "failure") older.reject(new Error("Older selection failed"));
      else older.resolve({});
      await flushAsyncWork();

      expect(
        useAppStore.getState().threads.find((thread) => thread.id === threadId)?.reasoningEffort,
      ).toBe("medium");
      expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBe(
        "medium",
      );
    },
  );

  test.each(["model first", "reasoning first"])(
    "a failed newer effort uses the confirmed model reset (%s)",
    async (order) => {
      const { threadId } = seedStore(
        { reasoningEffort: "high" },
        { composerReasoningEffort: "high" },
      );
      const model = deferredRequest();
      const reasoning = deferredRequest();
      jsonRpcHandlers.set("cowork/session/model/set", () => model.promise);
      jsonRpcHandlers.set("cowork/session/config/set", () => reasoning.promise);
      useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4");
      useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "low");
      await flushAsyncWork();
      const settleModel = () => model.resolve({});
      const settleReasoning = () => reasoning.reject(new Error("Effort rejected"));
      for (const settle of order === "model first"
        ? [settleModel, settleReasoning]
        : [settleReasoning, settleModel]) {
        settle();
        await flushAsyncWork();
      }

      expect(
        useAppStore.getState().threads.find((thread) => thread.id === threadId)?.reasoningEffort,
      ).toBeUndefined();
      expect(
        useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort,
      ).toBeNull();
    },
  );

  test.each(["older first", "newer first"])(
    "overlapping reasoning failures return to the confirmed baseline (%s)",
    async (order) => {
      const { threadId } = seedStore(
        { reasoningEffort: "high" },
        { composerReasoningEffort: "high" },
      );
      const older = deferredRequest();
      const newer = deferredRequest();
      let requests = 0;
      jsonRpcHandlers.set("cowork/session/config/set", () =>
        requests++ === 0 ? older.promise : newer.promise,
      );
      useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "low");
      useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "medium");
      await flushAsyncWork();
      const failures = order === "older first" ? [older, newer] : [newer, older];
      for (const request of failures) {
        request.reject(new Error("Selection rejected"));
        await flushAsyncWork();
      }

      expect(
        useAppStore.getState().threads.find((thread) => thread.id === threadId)?.reasoningEffort,
      ).toBe("high");
      expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBe(
        "high",
      );
    },
  );

  test("restores owned draft defaults when every overlapping model request fails", async () => {
    const { threadId } = seedStore(
      { reasoningEffort: "high" },
      { composerReasoningEffort: "high" },
    );
    const pendingDefaults = {
      mode: "auto" as const,
      draftModelSelection: { provider: "openai" as const, model: "gpt-5.2" },
    };
    RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, pendingDefaults);
    const older = deferredRequest();
    const newer = deferredRequest();
    let requests = 0;
    jsonRpcHandlers.set("cowork/session/model/set", () =>
      requests++ === 0 ? older.promise : newer.promise,
    );
    useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4");
    useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4-mini");
    await flushAsyncWork();
    older.reject(new Error("First model rejected"));
    await flushAsyncWork();
    newer.reject(new Error("Second model rejected"));
    await flushAsyncWork();

    expect(
      useAppStore.getState().threads.find((thread) => thread.id === threadId)?.reasoningEffort,
    ).toBe("high");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBe(
      "high",
    );
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId)).toBe(pendingDefaults);
  });

  test("failed model requests do not restore draft defaults replaced by another operation", async () => {
    const { threadId } = seedStore(
      { reasoningEffort: "high" },
      { composerReasoningEffort: "high" },
    );
    RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
      mode: "auto",
      draftModelSelection: { provider: "openai", model: "gpt-5.2" },
    });
    const request = deferredRequest();
    jsonRpcHandlers.set("cowork/session/model/set", () => request.promise);
    useAppStore.getState().setThreadModel(threadId, "openai", "gpt-5.4");
    await flushAsyncWork();
    const replacement = {
      mode: "explicit" as const,
      draftModelSelection: { provider: "openai" as const, model: "gpt-5.4-mini" },
    };
    RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, replacement);
    request.reject(new Error("Model rejected"));
    await flushAsyncWork();

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId)).toBe(replacement);
  });

  test.each(["removed", "replaced"])(
    "a late preference rejection cannot recreate or mutate a %s session",
    async (kind) => {
      const { threadId } = seedStore(
        { reasoningEffort: "high" },
        { composerReasoningEffort: "high" },
      );
      const request = deferredRequest();
      jsonRpcHandlers.set("cowork/session/config/set", () => request.promise);
      useAppStore.getState().setThreadReasoningEffort(threadId, "openai", "low");
      await flushAsyncWork();
      if (kind === "removed") {
        await useAppStore.getState().removeThread(threadId);
      } else {
        setAppState(useAppStore, (state) => ({
          threadRuntimeById: {
            ...state.threadRuntimeById,
            [threadId]: {
              ...defaultThreadRuntime(),
              sessionId: "replacement",
              composerReasoningEffort: "medium",
            },
          },
        }));
      }
      request.reject(new Error("Late rejection"));
      await flushAsyncWork();

      if (kind === "removed") {
        expect(useAppStore.getState().threadRuntimeById[threadId]).toBeUndefined();
        expect(useAppStore.getState().threads.some((thread) => thread.id === threadId)).toBe(false);
      } else {
        expect(useAppStore.getState().threadRuntimeById[threadId]).toMatchObject({
          sessionId: "replacement",
          composerReasoningEffort: "medium",
        });
      }
      expect(
        useAppStore
          .getState()
          .notifications.filter((notification) => notification.detail?.includes("Late rejection")),
      ).toEqual([]);
    },
  );

  test("reconnectThread resumes through the workspace JsonRpcSocket", async () => {
    const { threadId, workspaceId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();
    const activeThreadId = canonicalThreadId("session-1", threadId);

    expect(RUNTIME.jsonRpcSockets.has(workspaceId)).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.connected).toBe(true);
    expect(
      useAppStore.getState().threads.find((thread) => thread.id === activeThreadId)?.status,
    ).toBe("active");
  });

  test("reconnectThreadWithFeedback reports a confirmed connection without changing drafts", async () => {
    const { threadId } = seedStore();
    const draftKey = `thread:${threadId}`;
    setAppState(useAppStore, (state) => ({
      composerDraftsByKey: {
        ...state.composerDraftsByKey,
        [draftKey]: {
          revision: 1,
          generation: 0,
          updatedAt: "2024-01-01T00:00:00.000Z",
          text: "Keep this draft through reconnect.",
          attachments: [],
          references: [],
        },
      },
    }));

    const result = await useAppStore.getState().reconnectThreadWithFeedback(threadId);
    await flushAsyncWork();

    expect(result.ok).toBe(true);
    expect(
      useAppStore.getState().operationsByKey[operationKey("thread-reconnect", threadId)]?.status,
    ).toBe("success");
    expect(useAppStore.getState().composerDraftsByKey[draftKey]?.text).toBe(
      "Keep this draft through reconnect.",
    );
  });

  test("cached session snapshots hydrate the thread model before reconnect", async () => {
    const { threadId } = seedStore();
    const snapshot = {
      ...threadSnapshot("session-1"),
      titleModel: "gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      requestedModel: "gpt-5.5",
      effectiveModel: "gpt-5.5",
    };
    setAppState(useAppStore, (state) => ({
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === state.threads[0]?.workspaceId
          ? {
              ...workspace,
              defaultProvider: "google",
              defaultModel: "gemini-3.5-flash",
            }
          : workspace,
      ),
    }));
    RUNTIME.sessionSnapshots.set("session-1", {
      fingerprint: {
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messageCount,
        lastEventSeq: snapshot.lastEventSeq,
      },
      snapshot,
    });
    jsonRpcHandlers.set("thread/read", async () => ({ coworkSnapshot: snapshot }));

    await hydrateThreadSelection(
      useAppStore.getState,
      setAppState.bind(null, useAppStore),
      threadId,
      {
        preserveView: true,
      },
    );
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[threadId]?.config).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      workingDirectory: "/tmp/workspace",
    });
  });

  test("canceling hydration releases its request so the same chat can be selected again", async () => {
    const { threadId } = seedStore();
    const controller = new AbortController();
    const hydration = hydrateThreadSelection(
      useAppStore.getState,
      setAppState.bind(null, useAppStore),
      threadId,
      {
        signal: controller.signal,
      },
    );

    controller.abort();
    await hydration;

    expect(RUNTIME.threadSelectionRequests.has(threadId)).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.hydrating).toBe(false);

    await hydrateThreadSelection(
      useAppStore.getState,
      setAppState.bind(null, useAppStore),
      threadId,
    );

    expect(jsonRpcRequests.some((request) => request.method === "thread/read")).toBe(true);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed).toEqual(
      threadSnapshot("session-1").feed,
    );
    expect(RUNTIME.threadSelectionRequests.has(threadId)).toBe(false);
  });

  test("a failed reconnect releases hydration ownership without losing the loaded transcript", async () => {
    const { threadId } = seedStore();
    const reconnectThread = useAppStore.getState().reconnectThread;
    setAppState(useAppStore, {
      reconnectThread: async () => {
        throw new Error("Reconnect failed");
      },
    });

    try {
      await expect(
        hydrateThreadSelection(
          useAppStore.getState,
          setAppState.bind(null, useAppStore),
          threadId,
          {
            reconnectAfterHydration: true,
          },
        ),
      ).rejects.toThrow("Reconnect failed");
      expect(RUNTIME.threadSelectionRequests.has(threadId)).toBe(false);
      expect(useAppStore.getState().threadRuntimeById[threadId]?.hydrating).toBe(false);
      expect(useAppStore.getState().threadRuntimeById[threadId]?.feed).toEqual(
        threadSnapshot("session-1").feed,
      );
    } finally {
      setAppState(useAppStore, { reconnectThread });
    }
  });

  test("reconnectThread dedupes an in-flight connect after draft thread identity migration", async () => {
    const draftThreadId = "draft-thread-1";
    seedStore(
      {
        id: draftThreadId,
        sessionId: null,
        draft: true,
      },
      {
        sessionId: null,
      },
    );

    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    jsonRpcHandlers.set("thread/start", async () => ({
      thread: threadMeta("session-2"),
    }));
    jsonRpcHandlers.set("thread/read", async () => {
      await readBlocked;
      return {
        coworkSnapshot: threadSnapshot("session-2"),
      };
    });

    await useAppStore.getState().reconnectThread(draftThreadId, "hello once");
    await flushAsyncWork();

    const migratedThreadId = canonicalThreadId("session-2", draftThreadId);
    expect(migratedThreadId).toBe("session-2");
    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);

    await useAppStore.getState().reconnectThread(migratedThreadId);
    await flushAsyncWork();

    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/start")).toHaveLength(1);
    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/resume")).toHaveLength(0);

    releaseRead();
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[migratedThreadId]?.connected).toBe(true);
  });

  test("queued first message flushes without waiting for an in-flight defaults apply", async () => {
    const draftThreadId = "draft-thread-early-flush";
    seedStore(
      {
        id: draftThreadId,
        sessionId: null,
        draft: true,
      },
      {
        sessionId: null,
      },
    );

    let applyStarted = false;
    let releaseApply!: () => void;
    const applyBlocked = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    jsonRpcHandlers.set("cowork/session/defaults/apply", async () => {
      applyStarted = true;
      await applyBlocked;
      return {
        event: {
          type: "session_config",
          sessionId: "session-1",
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
    });

    await useAppStore.getState().reconnectThread(draftThreadId, "hello early flush");
    for (let attempt = 0; attempt < 50 && !applyStarted; attempt += 1) {
      await flushAsyncWork();
    }
    expect(applyStarted).toBe(true);

    // The queued first message dispatches while the apply is still unresolved;
    // the server orders the turn behind it via `pendingConfigMutation`.
    const applyIndex = jsonRpcRequests.findIndex(
      (entry) => entry.method === "cowork/session/defaults/apply",
    );
    const turnStarts = jsonRpcRequests.filter((entry) => entry.method === "turn/start");
    expect(applyIndex).toBeGreaterThanOrEqual(0);
    expect(turnStarts).toHaveLength(1);
    expect(jsonRpcRequests.indexOf(turnStarts[0] as { method: string })).toBeGreaterThan(
      applyIndex,
    );
    expect(turnStarts[0]?.params).toMatchObject({
      input: [{ type: "text", text: "hello early flush" }],
    });

    const migratedThreadId = canonicalThreadId("session-1", draftThreadId);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(migratedThreadId)?.inFlight).toBe(true);

    releaseApply();
    await flushAsyncWork();
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(migratedThreadId)).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[migratedThreadId]?.connected).toBe(true);
  });

  for (const editWhileSending of [false, true]) {
    test(`attachment-only queued send promotes identity and retains draft ownership (edited=${editWhileSending})`, async () => {
      const localThreadId = "draft-attachment-owner";
      const serverThreadId = "promoted-attachment-owner";
      seedStore({ id: localThreadId, sessionId: null, draft: true }, { sessionId: null });
      const localKey = composerDraftKeyForThread(localThreadId);
      const serverKey = composerDraftKeyForThread(serverThreadId);
      const attachments = [{ filename: "brief.txt", contentBase64: "YnJpZWY=" }];
      const references = [{ kind: "skill" as const, name: "documents" }];
      const owner = { key: localKey, revision: 7, submissionId: "promoted-submission" };
      const draft = { ...createEmptyComposerDraft(), revision: 7, text: "owned draft", references };
      setAppState(useAppStore, {
        composerDraftsByKey: { [localKey]: draft },
        composerSubmissionsByKey: {
          [localKey]: {
            id: owner.submissionId,
            clientMessageId: "promoted-message",
            owner,
            request: { kind: "thread", threadId: localThreadId },
            draft,
            prepared: null,
            phase: "sending",
            delivery: "send",
            error: null,
          },
        },
      });
      let acceptTurn!: () => void;
      const pendingTurn = new Promise<void>((resolve) => {
        acceptTurn = resolve;
      });
      jsonRpcHandlers.set("thread/start", async () => ({ thread: threadMeta(serverThreadId) }));
      jsonRpcHandlers.set("turn/start", async () => {
        await pendingTurn;
        return { turn: { id: "accepted-turn" } };
      });

      await useAppStore.getState().reconnectThread(localThreadId, "", {
        attachments,
        references,
        clientMessageId: "promoted-message",
        draftSubmission: owner,
      });
      await flushAsyncWork();

      const sends = jsonRpcRequests.filter((entry) => entry.method === "turn/start");
      expect(sends).toHaveLength(1);
      expect(sends[0]?.params).toMatchObject({
        threadId: serverThreadId,
        clientMessageId: "promoted-message",
        input: [{ type: "file", ...attachments[0] }],
        references,
      });
      expect(RUNTIME.pendingThreadMessages.has(localThreadId)).toBe(false);
      expect(RUNTIME.pendingThreadMessages.has(serverThreadId)).toBe(false);
      expect(useAppStore.getState().composerDraftsByKey[localKey]).toBeUndefined();
      expect(useAppStore.getState().composerSubmissionsByKey[localKey]).toBeUndefined();
      expect(useAppStore.getState().composerSubmissionsByKey[serverKey]?.owner).toEqual({
        ...owner,
        key: serverKey,
      });
      expect(useAppStore.getState().composerDraftsByKey[serverKey]).toEqual(draft);
      const editedDraft = { ...draft, revision: 8, text: "later edits" };
      if (editWhileSending)
        setAppState(useAppStore, { composerDraftsByKey: { [serverKey]: editedDraft } });

      acceptTurn();
      await flushAsyncWork();

      expect(useAppStore.getState().composerSubmissionsByKey[serverKey]).toBeUndefined();
      const finalDraft = useAppStore.getState().composerDraftsByKey[serverKey];
      if (editWhileSending) expect(finalDraft).toEqual(editedDraft);
      else expect(finalDraft).toBeUndefined();
      const userMessages = useAppStore
        .getState()
        .threadRuntimeById[serverThreadId]?.feed.filter(
          (item) => item.kind === "message" && item.role === "user",
        );
      expect(userMessages?.map((item) => item.id)).toEqual(["promoted-message"]);
    });
  }

  test("selectThread falls back to transcript hydration when thread/read has no snapshot", async () => {
    jsonRpcHandlers.set("thread/read", async () => ({ coworkSnapshot: null }));
    const { threadId } = seedStore({
      legacyTranscriptId: "legacy-thread-1",
    });

    await useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.transcriptOnly).toBe(true);
    expect(runtime?.feed[0]?.kind).toBe("message");
    expect(runtime?.feed[0]?.role).toBe("assistant");
    expect(readTranscriptCalls).toEqual(["legacy-thread-1", "session-1", threadId]);
    expect(jsonRpcRequests.map((entry) => entry.method)).not.toContain("thread/resume");
  });

  test("selectThread uses harness snapshot when available and does not read transcript cache", async () => {
    const { threadId } = seedStore();

    await useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.transcriptOnly).toBe(false);
    expect(runtime?.feed[0]?.text).toBe("Hello from harness snapshot");
    expect(readTranscriptCalls).toEqual([]);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
  });

  test("an older reconnect snapshot cannot erase a response that already finished", async () => {
    const { threadId } = seedStore(
      {
        lastEventSeq: 12,
        messageCount: 4,
        lastMessageAt: "2024-01-01T00:00:12.000Z",
      },
      {
        busy: false,
        lastEventSeq: 12,
        feed: [
          {
            id: "assistant-finished-after-read-began",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:12.000Z",
            text: "The completed answer must remain visible.",
          },
        ],
      },
    );

    jsonRpcHandlers.set("thread/list", async () => ({
      threads: [
        {
          ...threadMeta("session-1"),
          updatedAt: "2024-01-01T00:00:12.000Z",
          messageCount: 4,
          lastEventSeq: 12,
        },
      ],
    }));
    jsonRpcHandlers.set("thread/read", async () => ({
      coworkSnapshot: {
        ...threadSnapshot("session-1"),
        lastEventSeq: 4,
        messageCount: 2,
        updatedAt: "2024-01-01T00:00:04.000Z",
        feed: [
          {
            id: "snapshot-before-response-finished",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:04.000Z",
            text: "A stale response from before the request completed.",
          },
        ],
      },
    }));

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const state = useAppStore.getState();
    expect(state.threadRuntimeById[activeThreadId]?.busy).toBe(false);
    expect(state.threadRuntimeById[activeThreadId]?.lastEventSeq).toBeGreaterThanOrEqual(12);
    expect(state.threadRuntimeById[activeThreadId]?.feed).toEqual([
      expect.objectContaining({
        id: "assistant-finished-after-read-began",
        text: "The completed answer must remain visible.",
      }),
    ]);
    const restoredThread = state.threads.find((thread) => thread.id === activeThreadId);
    expect(restoredThread?.lastEventSeq).toBeGreaterThanOrEqual(12);
    expect(restoredThread).toMatchObject({
      messageCount: 4,
      lastMessageAt: "2024-01-01T00:00:12.000Z",
    });
  });

  test("reconnectThread replaces stale feed when replay health requires a snapshot", async () => {
    const { threadId } = seedStore(
      {
        lastEventSeq: 10,
      },
      {
        busy: true,
        feed: [
          {
            id: "stale-journal-item",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:03.000Z",
            text: "Stale journal projection",
          },
        ],
      },
    );

    jsonRpcHandlers.set("thread/resume", async () => ({
      thread: threadMeta("session-1"),
      replayHealth: {
        snapshotRequired: true,
      },
    }));
    jsonRpcHandlers.set("thread/read", async () => ({
      coworkSnapshot: {
        ...threadSnapshot("session-1"),
        lastEventSeq: 4,
        feed: [
          {
            id: "snapshot-authoritative",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:02.000Z",
            text: "Authoritative snapshot",
          },
        ],
      },
    }));

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.feed.map((item) => item.id)).toEqual(["snapshot-authoritative"]);
  });

  test("forced replay snapshots preserve missing optimistic user messages", async () => {
    const { threadId } = seedStore(
      {
        lastEventSeq: 10,
      },
      {
        busy: true,
        feed: [
          {
            id: "stale-journal-item",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:03.000Z",
            text: "Stale journal projection",
          },
          {
            id: "client-msg-force",
            kind: "message",
            role: "user",
            ts: "2024-01-01T00:00:04.000Z",
            text: "Still sending",
          },
        ],
      },
    );
    const activeThreadId = canonicalThreadId("session-1", threadId);
    RUNTIME.optimisticUserMessageIds.set(activeThreadId, new Set(["client-msg-force"]));

    jsonRpcHandlers.set("thread/resume", async () => ({
      thread: threadMeta("session-1"),
      replayHealth: {
        snapshotRequired: true,
      },
    }));
    jsonRpcHandlers.set("thread/read", async () => ({
      coworkSnapshot: {
        ...threadSnapshot("session-1"),
        lastEventSeq: 4,
        feed: [
          {
            id: "snapshot-authoritative",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:02.000Z",
            text: "Authoritative snapshot",
          },
        ],
      },
    }));

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.feed.map((item) => item.id)).toEqual([
      "snapshot-authoritative",
      "client-msg-force",
    ]);
  });

  test("selectThread reasserts resume for an already connected selected thread", async () => {
    const { threadId } = seedStore(
      {
        status: "active",
      },
      {
        connected: true,
        feed: threadSnapshot("session-1").feed,
      },
    );
    setAppState(useAppStore, { selectedThreadId: threadId });

    await useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const methods = jsonRpcRequests.map((entry) => entry.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/read");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.connected).toBe(true);
  });

  test("selectThread still hydrates when requestAnimationFrame is throttled", async () => {
    installWindowMock({
      requestAnimationFrame: mock(() => 1),
    });
    const { threadId } = seedStore();

    await useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.hydrating).toBe(false);
  });

  test("reconnectThread does not duplicate user message when snapshot has formatted userMessage ID", async () => {
    const { threadId } = seedStore(
      {},
      {
        feed: [
          {
            id: "client-msg-123",
            kind: "message",
            role: "user",
            ts: "2024-01-01T00:00:01.000Z",
            text: "Hello from client",
          },
        ],
      },
    );

    const activeThreadId = canonicalThreadId("session-1", threadId);
    let optimisticSet = RUNTIME.optimisticUserMessageIds.get(activeThreadId);
    if (!optimisticSet) {
      optimisticSet = new Set();
      RUNTIME.optimisticUserMessageIds.set(activeThreadId, optimisticSet);
    }
    optimisticSet.add("client-msg-123");

    jsonRpcHandlers.set("thread/read", async () => ({
      coworkSnapshot: {
        ...threadSnapshot("session-1"),
        feed: [
          {
            id: "userMessage:turn-xyz:client-msg-123",
            kind: "message",
            role: "user",
            ts: "2024-01-01T00:00:01.000Z",
            text: "Hello from client",
          },
          {
            id: "assistant-1",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:02.000Z",
            text: "Hello from harness snapshot",
          },
        ],
      },
    }));

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[activeThreadId];
    expect(runtime?.feed).toHaveLength(2);
    expect(runtime?.feed.map((f) => f.id)).toEqual([
      "userMessage:turn-xyz:client-msg-123",
      "assistant-1",
    ]);
  });

  test("closing and reopening the shared JsonRpcSocket disconnects and auto-resumes tracked threads", async () => {
    const { threadId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();

    socket.close();
    await flushAsyncWork();
    const disconnectedThreadId = canonicalThreadId("session-1", threadId);
    expect(useAppStore.getState().threadRuntimeById[disconnectedThreadId]?.connected).toBe(false);
    expect(
      useAppStore.getState().threads.find((thread) => thread.id === disconnectedThreadId)?.status,
    ).toBe("disconnected");
    const disconnectedState = useAppStore.getState();
    const disconnectedThread = disconnectedState.threads.find(
      (thread) => thread.id === disconnectedThreadId,
    );
    const disconnectedRuntime = disconnectedState.threadRuntimeById[disconnectedThreadId];
    expect(
      shouldShowReconnectBanner({
        conversationVisible: true,
        threadId: disconnectedThreadId,
        threadStatus: disconnectedThread?.status ?? null,
        transcriptOnly: disconnectedRuntime?.transcriptOnly === true,
        connected: disconnectedRuntime?.connected === true,
        sessionId: disconnectedRuntime?.sessionId ?? null,
        hydrating: disconnectedRuntime?.hydrating === true,
        workspaceStarting: false,
        terminalTaskConversation: false,
      }),
    ).toBe(true);

    socket.reopen();
    await flushAsyncWork();

    expect(jsonRpcRequests.filter((entry) => entry.method === "thread/resume")).toHaveLength(2);
    const resumedThreadId = canonicalThreadId("session-1", threadId);
    expect(useAppStore.getState().threadRuntimeById[resumedThreadId]?.connected).toBe(true);
    expect(
      useAppStore.getState().threads.find((thread) => thread.id === resumedThreadId)?.status,
    ).toBe("active");
    const resumedState = useAppStore.getState();
    const resumedThread = resumedState.threads.find((thread) => thread.id === resumedThreadId);
    const resumedRuntime = resumedState.threadRuntimeById[resumedThreadId];
    expect(
      shouldShowReconnectBanner({
        conversationVisible: true,
        threadId: resumedThreadId,
        threadStatus: resumedThread?.status ?? null,
        transcriptOnly: resumedRuntime?.transcriptOnly === true,
        connected: resumedRuntime?.connected === true,
        sessionId: resumedRuntime?.sessionId ?? null,
        hydrating: resumedRuntime?.hydrating === true,
        workspaceStarting: false,
        terminalTaskConversation: false,
      }),
    ).toBe(false);
  });

  test("preserves active work and pending delivery while a lost connection is retrying", async () => {
    const { threadId, workspaceId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    setAppState(useAppStore, (state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [activeThreadId]: {
          ...state.threadRuntimeById[activeThreadId],
          busy: true,
          busySince: "2026-08-24T12:00:00.000Z",
          activeTurnId: "turn-running",
          pendingTurnStart: {
            clientMessageId: "durable-message-1",
            text: "Keep this delivery alive",
            status: "sending",
          },
          pendingSteer: {
            clientMessageId: "durable-steer-1",
            text: "Keep this guidance visible",
            status: "sending",
          },
          interruptPending: true,
        },
      },
      interactionsByThread: {
        ...state.interactionsByThread,
        [activeThreadId]: [
          {
            kind: "ask",
            requestId: "approval-running",
            receivedSequence: 1,
            question: "Keep waiting for this answer?",
            status: "responding",
          },
        ],
      },
    }));

    const socket = MockJsonRpcSocket.instances[0];
    socket.reconnecting();
    await flushAsyncWork();

    const reconnecting = useAppStore.getState();
    expect(reconnecting.workspaceRuntimeById[workspaceId]?.reconnecting).toBe(true);
    expect(reconnecting.threadRuntimeById[activeThreadId]).toMatchObject({
      connected: false,
      busy: true,
      busySince: "2026-08-24T12:00:00.000Z",
      activeTurnId: "turn-running",
      pendingTurnStart: { clientMessageId: "durable-message-1", status: "sending" },
      pendingSteer: { clientMessageId: "durable-steer-1", status: "sending" },
      interruptPending: true,
    });
    expect(reconnecting.interactionsByThread[activeThreadId]).toEqual([
      expect.objectContaining({ requestId: "approval-running", status: "responding" }),
    ]);

    socket.reconnectExhausted();
    await flushAsyncWork();

    const exhausted = useAppStore.getState();
    expect(exhausted.workspaceRuntimeById[workspaceId]?.reconnecting).toBe(false);
    expect(exhausted.threadRuntimeById[activeThreadId]).toMatchObject({
      connected: false,
      busy: false,
      activeTurnId: null,
      pendingTurnStart: null,
      pendingSteer: null,
      interruptPending: false,
    });
    expect(exhausted.interactionsByThread[activeThreadId]).toEqual([
      expect.objectContaining({ requestId: "approval-running", status: "failed" }),
    ]);
  });

  test("retries automatic thread recovery after one temporary resume failure", async () => {
    const { threadId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const activeThreadId = canonicalThreadId("session-1", threadId);
    const socket = MockJsonRpcSocket.instances[0];
    let recoveryAttempts = 0;
    jsonRpcHandlers.set("thread/resume", async () => {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) {
        throw new Error("The workspace server is still recovering.");
      }
      return { thread: threadMeta("session-1") };
    });

    socket.close();
    await flushAsyncWork();
    socket.reopen();
    await flushAsyncWork();

    expect(recoveryAttempts).toBe(1);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.connected).toBe(false);

    socket.close();
    await flushAsyncWork();
    socket.reopen();
    await flushAsyncWork();

    expect(recoveryAttempts).toBe(2);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.connected).toBe(true);
    expect(
      useAppStore.getState().threads.find((thread) => thread.id === activeThreadId)?.status,
    ).toBe("active");
  });

  test("stale shared JsonRpcSocket close after a serverUrl swap does not disconnect tracked threads", async () => {
    const { threadId, workspaceId } = seedStore();

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const firstSocket = MockJsonRpcSocket.instances[0];
    expect(firstSocket).toBeDefined();
    expect(useAppStore.getState().threadRuntimeById[threadId]?.connected).toBe(true);
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.status).toBe(
      "active",
    );

    MockJsonRpcSocket.deferClose = true;
    setAppState(useAppStore, (state) => ({
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          serverUrl: "ws://changed",
        },
      },
    }));

    await useAppStore.getState().reconnectThread(threadId);
    await flushAsyncWork();

    const secondSocket = MockJsonRpcSocket.instances[1];
    expect(secondSocket).toBeDefined();
    expect(secondSocket).not.toBe(firstSocket);
    expect((firstSocket as MockJsonRpcSocket).closed).toBe(true);
    expect(RUNTIME.jsonRpcSockets.get(workspaceId)).toBe(secondSocket);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.connected).toBe(true);
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.status).toBe(
      "active",
    );

    (firstSocket as MockJsonRpcSocket).emitDeferredClose();
    await flushAsyncWork();

    expect(RUNTIME.jsonRpcSockets.get(workspaceId)).toBe(secondSocket);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.connected).toBe(true);
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.status).toBe(
      "active",
    );
  });
});
