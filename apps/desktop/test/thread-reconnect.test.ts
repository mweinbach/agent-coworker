import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  url: string;
  client: string;
  autoReconnect?: boolean;
  resumeSessionId?: string;
  onEvent?: (evt: any) => void;
  onClose?: (reason: string) => void;
};

class MockAgentSocket {
  public sent: any[] = [];

  constructor(public readonly opts: MockSocketOpts) {
    MOCK_SOCKETS.push(this);
  }

  connect() {}

  send(msg: any) {
    this.sent.push(msg);
    return true;
  }

  close() {
    this.opts.onClose?.("closed");
  }

  emit(evt: any) {
    this.opts.onEvent?.(evt);
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await Promise.resolve();
}

const MOCK_SOCKETS: MockAgentSocket[] = [];
let mockedTranscript: any[] = [];
let mockedTranscriptError: Error | null = null;
let readTranscriptImpl: ((threadId: string) => Promise<any[]>) | null = null;
const readTranscriptCalls: string[] = [];
const appendTranscriptBatchCalls: Array<Array<{ ts: string; threadId: string; direction: "server" | "client"; payload: unknown }>> = [];
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

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async (events: Array<{ ts: string; threadId: string; direction: "server" | "client"; payload: unknown }>) => {
    appendTranscriptBatchCalls.push(events);
  },
  appendTranscriptEvent: async () => {},
  deleteTranscript: async ({ threadId }: { threadId: string }) => {
    deleteTranscriptCalls.push(threadId);
  },
  listDirectory: async () => [],
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async ({ threadId }: { threadId: string }) => {
    readTranscriptCalls.push(threadId);
    if (readTranscriptImpl) {
      return await readTranscriptImpl(threadId);
    }
    if (mockedTranscriptError) {
      throw mockedTranscriptError;
    }
    return mockedTranscript;
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
const { RUNTIME, defaultThreadRuntime } = await import("../src/app/store.helpers");

function socketByClient(client: string): MockAgentSocket {
  const socket = [...MOCK_SOCKETS].reverse().find((s) => s.opts.client === client);
  if (!socket) throw new Error(`Missing mock socket for client=${client}`);
  return socket;
}

function emitServerHello(
  socket: MockAgentSocket,
  sessionId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  socket.emit({
    type: "server_hello",
    sessionId,
    protocolVersion: "2.0",
    config: {
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
      outputDirectory: "/tmp/workspace/output",
    },
    ...overrides,
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
      preferredChildModel: "gemini-3.1-pro-preview-customtools",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "google:gemini-3.1-pro-preview-customtools",
      allowedChildModelRefs: [],
      maxSteps: 100,
      toolOutputOverflowChars: 25000,
      ...(overrides.config ?? {}),
    },
  });
}

function canonicalThreadId(sessionId: string, fallbackThreadId?: string): string {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) =>
    item.id === sessionId
    || item.sessionId === sessionId
    || (fallbackThreadId ? item.legacyTranscriptId === fallbackThreadId : false),
  );
  return thread?.id ?? state.selectedThreadId ?? fallbackThreadId ?? sessionId;
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

describe("thread reconnect", () => {
  let workspaceId = "";
  let threadId = "";

  beforeEach(() => {
    workspaceId = `ws-${crypto.randomUUID()}`;
    threadId = `t-${crypto.randomUUID()}`;
    MOCK_SOCKETS.length = 0;
    mockedTranscript = [];
    mockedTranscriptError = null;
    readTranscriptImpl = null;
    readTranscriptCalls.length = 0;
    appendTranscriptBatchCalls.length = 0;
    deleteTranscriptCalls.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.threadSockets.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadSteers.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.pendingWorkspaceDefaultApplyByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.modelStreamByThread.clear();
    RUNTIME.sessionSnapshots.clear();

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
          lastMessageAt: "2024-01-01T00:00:00.000Z",
          status: "disconnected",
          sessionId: null,
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
      selectedWorkspaceId: workspaceId,
      selectedThreadId: null,
      workspaceRuntimeById: {},
      threadRuntimeById: {},
      notifications: [],
      promptModal: null,
      providerStatusByName: {},
      providerStatusLastUpdatedAt: null,
      providerStatusRefreshing: false,
      composerText: "",
      injectContext: false,
    });
  });

  test("selectThread attempts to reconnect disconnected threads", async () => {
    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    expect(threadSocket.opts.autoReconnect).toBe(true);
    emitServerHello(threadSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);
    expect(threadSocket.sent).toContainEqual({ type: "get_session_usage", sessionId: "thread-session" });

    const state = useAppStore.getState();
    const thread = state.threads.find((t) => t.id === activeThreadId);
    expect(thread?.status).toBe("active");
    expect(state.threadRuntimeById[activeThreadId]?.connected).toBe(true);
    expect(state.threadRuntimeById[activeThreadId]?.sessionId).toBe("thread-session");
    expect(state.threadRuntimeById[activeThreadId]?.transcriptOnly).toBe(false);
  });

  test("rapid thread switching ignores stale transcript hydration and reconnect", async () => {
    const secondThreadId = `t-${crypto.randomUUID()}`;
    useAppStore.setState((state) => ({
      ...state,
      threads: [
        ...state.threads,
        {
          id: secondThreadId,
          workspaceId,
          title: "Thread 2",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:00.000Z",
          status: "disconnected",
        },
      ],
    }));

    const transcriptDeferreds = new Map<string, Deferred<any[]>>([
      [threadId, createDeferred<any[]>()],
      [secondThreadId, createDeferred<any[]>()],
    ]);
    readTranscriptImpl = async (targetThreadId) => await transcriptDeferreds.get(targetThreadId)!.promise;

    const firstSelect = useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();
    expect(readTranscriptCalls).toEqual([threadId]);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.hydrating).toBe(true);

    const secondSelect = useAppStore.getState().selectThread(secondThreadId);
    await flushAsyncWork();
    expect(readTranscriptCalls).toEqual([threadId, secondThreadId]);
    expect(useAppStore.getState().selectedThreadId).toBe(secondThreadId);
    expect(useAppStore.getState().threadRuntimeById[secondThreadId]?.hydrating).toBe(true);

    transcriptDeferreds.get(secondThreadId)!.resolve([]);
    await secondSelect;

    const threadSocketsAfterLatestSelect = MOCK_SOCKETS.filter((socket) => socket.opts.client === "desktop");
    expect(threadSocketsAfterLatestSelect).toHaveLength(1);
    const latestSocket = threadSocketsAfterLatestSelect[0];
    expect(latestSocket?.opts.resumeSessionId).toBeUndefined();

    transcriptDeferreds.get(threadId)!.resolve([]);
    await firstSelect;

    expect(MOCK_SOCKETS.filter((socket) => socket.opts.client === "desktop")).toHaveLength(1);
    expect(useAppStore.getState().selectedThreadId).toBe(secondThreadId);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.hydrating).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[secondThreadId]?.hydrating).toBe(false);
  });

  test("selectThread hydrates from harness session_snapshot before transcript fallback", async () => {
    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              sessionId: "persisted-thread-session",
              messageCount: 2,
              lastEventSeq: 4,
            }
          : thread,
      ),
    }));
    readTranscriptImpl = async () => {
      throw new Error("readTranscript should not be used when a session snapshot is available");
    };

    const selectPromise = useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: "persisted-thread-session",
    });
    controlSocket.emit({
      type: "session_snapshot",
      sessionId: "control-session",
      targetSessionId: "persisted-thread-session",
      snapshot: makeSessionSnapshot("persisted-thread-session"),
    });

    await selectPromise;

    expect(readTranscriptCalls).toEqual([]);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed).toEqual([
      {
        id: "assistant-1",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:02.000Z",
        text: "Hello from harness snapshot",
      },
    ]);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.transcriptOnly).toBe(false);
  });

  test("selectThread falls back immediately when session snapshot lookup errors", async () => {
    const rekeyedThreadId = "persisted-thread-session";
    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              id: rekeyedThreadId,
              sessionId: rekeyedThreadId,
              messageCount: 2,
              lastEventSeq: 4,
              legacyTranscriptId: threadId,
            }
          : thread,
      ),
    }));
    readTranscriptImpl = async (requestedThreadId) => requestedThreadId === threadId
      ? [
          {
            ts: "2024-01-01T00:00:01.000Z",
            threadId: "legacy-thread-id",
            direction: "server",
            payload: {
              type: "assistant_message",
              sessionId: rekeyedThreadId,
              text: "Recovered from transcript",
            },
          },
        ]
      : [];

    const selectPromise = useAppStore.getState().selectThread(rekeyedThreadId);
    await flushAsyncWork();

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    controlSocket.emit({
      type: "error",
      sessionId: "control-session",
      source: "session",
      code: "validation_failed",
      message: `Unknown target session: ${rekeyedThreadId}`,
    });

    await expect(Promise.race([
      selectPromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ])).resolves.toBe(true);
    await selectPromise;

    expect(readTranscriptCalls).toEqual(expect.arrayContaining([threadId, rekeyedThreadId]));
    expect(useAppStore.getState().threadRuntimeById[rekeyedThreadId]?.feed).toEqual([
      {
        id: expect.any(String),
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:01.000Z",
        text: "Recovered from transcript",
      },
    ]);
  });

  test("selectThread keeps reconnecting when a cached snapshot is valid but the live snapshot lookup returns null", async () => {
    const persistedSessionId = "persisted-thread-session";
    const snapshot = makeSessionSnapshot(persistedSessionId);
    RUNTIME.sessionSnapshots.set(persistedSessionId, {
      fingerprint: {
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messageCount,
        lastEventSeq: snapshot.lastEventSeq,
      },
      snapshot,
    });

    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              sessionId: persistedSessionId,
              lastMessageAt: snapshot.updatedAt,
              messageCount: snapshot.messageCount,
              lastEventSeq: snapshot.lastEventSeq,
            }
          : thread,
      ),
    }));
    readTranscriptImpl = async () => {
      throw new Error("readTranscript should not run when a matching cached snapshot was already applied");
    };

    const selectPromise = useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: persistedSessionId,
    });

    controlSocket.emit({
      type: "error",
      sessionId: "control-session",
      source: "session",
      code: "validation_failed",
      message: `Unknown target session: ${persistedSessionId}`,
    });
    await flushAsyncWork();

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, persistedSessionId);
    await selectPromise;

    const activeThreadId = canonicalThreadId(persistedSessionId, threadId);
    expect(readTranscriptCalls).toEqual([]);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.feed).toEqual(snapshot.feed);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.transcriptOnly).toBe(false);
  });

  test("snapshot errors only resolve the waiter for the failing target session", async () => {
    const secondThreadId = `t-${crypto.randomUUID()}`;
    const firstSessionId = "persisted-thread-session-a";
    const secondSessionId = "persisted-thread-session-b";
    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.flatMap((thread) =>
        thread.id === threadId
          ? [
              {
                ...thread,
                sessionId: firstSessionId,
                messageCount: 2,
                lastEventSeq: 4,
              },
              {
                ...thread,
                id: secondThreadId,
                title: "Thread 2",
                sessionId: secondSessionId,
                messageCount: 2,
                lastEventSeq: 4,
              },
            ]
          : [thread],
      ),
    }));
    readTranscriptImpl = async () => {
      throw new Error("readTranscript should not run when an unrelated snapshot request fails");
    };

    const firstSelect = useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: firstSessionId,
    });

    const secondSelect = useAppStore.getState().selectThread(secondThreadId);
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: secondSessionId,
    });

    controlSocket.emit({
      type: "error",
      sessionId: "control-session",
      source: "session",
      code: "validation_failed",
      message: `Unknown target session: ${firstSessionId}`,
    });
    await flushAsyncWork();

    controlSocket.emit({
      type: "session_snapshot",
      sessionId: "control-session",
      targetSessionId: secondSessionId,
      snapshot: makeSessionSnapshot(secondSessionId, {
        title: "Second thread snapshot",
        feed: [
          {
            id: "assistant-second",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:03.000Z",
            text: "Second thread snapshot",
          },
        ],
      }),
    });
    await flushAsyncWork();

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, secondSessionId);
    await secondSelect;
    await firstSelect;

    const activeThreadId = canonicalThreadId(secondSessionId, secondThreadId);
    expect(readTranscriptCalls).toEqual([]);
    expect(useAppStore.getState().selectedThreadId).toBe(activeThreadId);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.feed).toEqual([
      {
        id: "assistant-second",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:03.000Z",
        text: "Second thread snapshot",
      },
    ]);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.transcriptOnly).toBe(false);
  });

  test("selectThread skips get_session_snapshot when feed is loaded and snapshot cache matches", async () => {
    const persistedSessionId = "persisted-thread-session";
    const snapshot = makeSessionSnapshot(persistedSessionId);
    RUNTIME.sessionSnapshots.set(persistedSessionId, {
      fingerprint: {
        updatedAt: snapshot.updatedAt,
        messageCount: snapshot.messageCount,
        lastEventSeq: snapshot.lastEventSeq,
      },
      snapshot,
    });

    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              sessionId: persistedSessionId,
              lastMessageAt: snapshot.updatedAt,
              messageCount: snapshot.messageCount,
              lastEventSeq: snapshot.lastEventSeq,
            }
          : thread,
      ),
      threadRuntimeById: {
        [threadId]: {
          ...defaultThreadRuntime(),
          sessionId: persistedSessionId,
          feed: snapshot.feed,
        },
      },
    }));

    readTranscriptImpl = async () => {
      throw new Error("readTranscript should not run when harness snapshot fetch is skipped");
    };

    const selectPromise = useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    const controlSocket = socketByClient("desktop-control");
    expect(controlSocket.sent.filter((msg: { type?: string }) => msg.type === "get_session_snapshot")).toEqual([]);

    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent.filter((msg: { type?: string }) => msg.type === "get_session_snapshot")).toEqual([]);

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, persistedSessionId);
    await selectPromise;

    expect(readTranscriptCalls).toEqual([]);
    expect(controlSocket.sent.filter((msg: { type?: string }) => msg.type === "get_session_snapshot")).toEqual([]);
    const activeThreadId = canonicalThreadId(persistedSessionId, threadId);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.feed).toEqual(snapshot.feed);
  });

  test("stale local snapshot cache is ignored when harness thread metadata changes", async () => {
    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              sessionId: "persisted-thread-session",
              lastMessageAt: "2024-01-01T00:00:10.000Z",
              messageCount: 5,
              lastEventSeq: 9,
            }
          : thread,
      ),
    }));
    RUNTIME.sessionSnapshots.set("persisted-thread-session", {
      fingerprint: {
        updatedAt: "2024-01-01T00:00:02.000Z",
        messageCount: 2,
        lastEventSeq: 4,
      },
      snapshot: makeSessionSnapshot("persisted-thread-session", {
        title: "Stale cached snapshot",
      }),
    });
    readTranscriptImpl = async () => {
      throw new Error("readTranscript should not be used when the harness snapshot request succeeds");
    };

    const selectPromise = useAppStore.getState().selectThread(threadId);
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed ?? []).toEqual([]);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    await flushAsyncWork();
    expect(controlSocket.sent).toContainEqual({
      type: "get_session_snapshot",
      sessionId: "control-session",
      targetSessionId: "persisted-thread-session",
    });
    controlSocket.emit({
      type: "session_snapshot",
      sessionId: "control-session",
      targetSessionId: "persisted-thread-session",
      snapshot: makeSessionSnapshot("persisted-thread-session", {
        title: "Fresh harness snapshot",
        updatedAt: "2024-01-01T00:00:10.000Z",
        messageCount: 5,
        lastEventSeq: 9,
        feed: [
          {
            id: "assistant-fresh",
            kind: "message",
            role: "assistant",
            ts: "2024-01-01T00:00:10.000Z",
            text: "Fresh harness snapshot",
          },
        ],
      }),
    });

    await selectPromise;

    expect(readTranscriptCalls).toEqual([]);
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.title).toBe("Fresh harness snapshot");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.feed).toEqual([
      {
        id: "assistant-fresh",
        kind: "message",
        role: "assistant",
        ts: "2024-01-01T00:00:10.000Z",
        text: "Fresh harness snapshot",
      },
    ]);
  });

  test("loadAllThreadUsage reads both legacy and canonical transcript ids", async () => {
    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              id: "persisted-thread-session",
              sessionId: "persisted-thread-session",
              legacyTranscriptId: "legacy-thread-id",
            }
          : thread,
      ),
      selectedThreadId: "persisted-thread-session",
      threadRuntimeById: {},
    }));
    readTranscriptImpl = async (requestedThreadId) => {
      if (requestedThreadId === "legacy-thread-id") {
        return [
          {
            ts: "2024-01-01T00:00:00.000Z",
            threadId: "legacy-thread-id",
            direction: "server",
            payload: {
              type: "session_usage",
              sessionId: "persisted-thread-session",
              usage: {
                sessionId: "persisted-thread-session",
                totalTurns: 1,
                totalPromptTokens: 10,
                totalCompletionTokens: 20,
                totalTokens: 30,
                estimatedTotalCostUsd: 0.01,
                costTrackingAvailable: true,
                byModel: [],
                turns: [],
                budgetStatus: {
                  configured: false,
                  warnAtUsd: null,
                  stopAtUsd: null,
                  warningTriggered: false,
                  stopTriggered: false,
                  currentCostUsd: null,
                },
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
              },
            },
          },
        ];
      }
      return [];
    };

    await useAppStore.getState().loadAllThreadUsage();

    expect(readTranscriptCalls).toEqual(expect.arrayContaining(["legacy-thread-id", "persisted-thread-session"]));
    expect(useAppStore.getState().threadRuntimeById["persisted-thread-session"]?.sessionUsage?.totalTokens).toBe(30);
  });

  test("resumed threads do not replay workspace default set_model on reconnect", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "codex-cli",
              defaultModel: "gpt-5.4",
            }
          : workspace,
      ),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              sessionId: "persisted-thread-session",
            }
          : thread,
      ),
    }));

    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    threadSocket.sent = [];
    emitServerHello(threadSocket, "persisted-thread-session", {
      isResume: true,
      config: {
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });
    threadSocket.sent = [];
    emitThreadSessionDefaults(threadSocket, "persisted-thread-session");

    expect(threadSocket.sent.some((message) => message?.type === "set_model")).toBe(false);
    expect(threadSocket.sent.some((message) => message?.type === "apply_session_defaults")).toBe(false);
  });

  test("deferred auto defaults preserve the draft model selection until session defaults arrive", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
            }
          : workspace,
      ),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              draft: true,
              status: "active",
            }
          : thread,
      ),
    }));

    await useAppStore.getState().selectThread(threadId);
    useAppStore.getState().setThreadModel(threadId, "codex-cli", "gpt-5.4");
    await useAppStore.getState().reconnectThread(threadId, "Hello from draft");

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session", {
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.draftComposerProvider).toBeNull();
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.draftComposerModel).toBeNull();
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: {
        provider: "codex-cli",
        model: "gpt-5.4",
      },
    });

    threadSocket.sent = [];
    threadSocket.emit({
      type: "session_settings",
      sessionId: "thread-session",
      enableMcp: true,
      enableMemory: true,
      memoryRequireApproval: false,
    });

    expect(threadSocket.sent).toEqual([]);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: {
        provider: "codex-cli",
        model: "gpt-5.4",
      },
    });

    emitThreadSessionDefaults(threadSocket, "thread-session");

    expect(threadSocket.sent).toContainEqual(
      expect.objectContaining({
        type: "apply_session_defaults",
        sessionId: "thread-session",
        provider: "codex-cli",
        model: "gpt-5.4",
      }),
    );
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(activeThreadId)).toBe(false);
  });

  test("draft first message waits for the selected model defaults before sending", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "codex-cli",
              defaultModel: "gpt-5.4",
            }
          : workspace,
      ),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              draft: true,
              status: "active",
            }
          : thread,
      ),
    }));

    await useAppStore.getState().selectThread(threadId);
    useAppStore.getState().setThreadModel(threadId, "google", "gemini-3.1-pro-preview-customtools");
    await useAppStore.getState().reconnectThread(threadId, "Hello from draft");

    const threadSocket = socketByClient("desktop");
    threadSocket.sent = [];
    emitServerHello(threadSocket, "thread-session", {
      config: {
        provider: "codex-cli",
        model: "gpt-5.4",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: {
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
      },
    });
    expect(threadSocket.sent.some((message) => message?.type === "user_message")).toBe(false);

    threadSocket.sent = [];
    emitThreadSessionDefaults(threadSocket, "thread-session");

    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
    });
    expect(threadSocket.sent[1]).toMatchObject({
      type: "user_message",
      sessionId: "thread-session",
      text: "Hello from draft",
    });
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(activeThreadId)).toBe(false);
  });

  test("session_busy idle does not flush a draft first message before deferred defaults complete", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "codex-cli",
              defaultModel: "gpt-5.4",
            }
          : workspace,
      ),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              draft: true,
              status: "active",
            }
          : thread,
      ),
    }));

    await useAppStore.getState().selectThread(threadId);
    useAppStore.getState().setThreadModel(threadId, "google", "gemini-3.1-pro-preview-customtools");
    await useAppStore.getState().reconnectThread(threadId, "Hello from draft");

    const threadSocket = socketByClient("desktop");
    threadSocket.sent = [];
    emitServerHello(threadSocket, "thread-session", {
      config: {
        provider: "codex-cli",
        model: "gpt-5.4",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: {
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
      },
    });
    expect(RUNTIME.pendingThreadMessages.get(activeThreadId)).toEqual(["Hello from draft"]);
    expect(threadSocket.sent.some((message) => message?.type === "user_message")).toBe(false);

    threadSocket.sent = [];
    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-1",
      outcome: "completed",
    });

    expect(threadSocket.sent).toEqual([]);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: {
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
      },
    });
    expect(RUNTIME.pendingThreadMessages.get(activeThreadId)).toEqual(["Hello from draft"]);

    emitThreadSessionDefaults(threadSocket, "thread-session");

    expect(threadSocket.sent[0]).toMatchObject({
      type: "apply_session_defaults",
      sessionId: "thread-session",
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
    });
    expect(threadSocket.sent[1]).toMatchObject({
      type: "user_message",
      sessionId: "thread-session",
      text: "Hello from draft",
    });
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(activeThreadId)).toBe(false);
  });

  test("live setThreadModel clears a deferred draft model override after connect", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "openai",
              defaultModel: "gpt-5.2",
            }
          : workspace,
      ),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              draft: true,
              status: "active",
            }
          : thread,
      ),
    }));

    await useAppStore.getState().selectThread(threadId);
    useAppStore.getState().setThreadModel(threadId, "codex-cli", "gpt-5.4");
    await useAppStore.getState().reconnectThread(threadId, "Hello from draft");

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: {
        provider: "codex-cli",
        model: "gpt-5.4",
      },
    });

    useAppStore.getState().setThreadModel(activeThreadId, "anthropic", "claude-3-7-sonnet");

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto",
      draftModelSelection: null,
    });
  });

  test("deferred auto-resume defaults preserve the resumed session model when the thread becomes idle", async () => {
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "codex-cli",
              defaultModel: "gpt-5.4",
            }
          : workspace,
      ),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              sessionId: "persisted-thread-session",
            }
          : thread,
      ),
    }));

    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    threadSocket.sent = [];
    emitServerHello(threadSocket, "persisted-thread-session", {
      isResume: true,
      busy: true,
      turnId: "turn-1",
      config: {
        provider: "google",
        model: "gemini-3.1-pro-preview-customtools",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });
    const activeThreadId = canonicalThreadId("persisted-thread-session", threadId);

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(activeThreadId)).toEqual({
      mode: "auto-resume",
      draftModelSelection: null,
    });

    threadSocket.sent = [];
    emitThreadSessionDefaults(threadSocket, "persisted-thread-session");
    threadSocket.sent = [];
    threadSocket.emit({
      type: "session_busy",
      sessionId: "persisted-thread-session",
      busy: false,
      turnId: "turn-1",
    });

    expect(threadSocket.sent.some((message) => message?.type === "set_model")).toBe(false);
    expect(threadSocket.sent.some((message) => message?.type === "apply_session_defaults")).toBe(false);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(activeThreadId)).toBe(false);
  });

  test("hydrates usage from transcript replay before reconnect", async () => {
    mockedTranscript = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "turn_usage",
          sessionId: "thread-session",
          turnId: "turn-1",
          usage: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
            cachedPromptTokens: 20,
            estimatedCostUsd: 0.0008,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "session_usage",
          sessionId: "thread-session",
          usage: {
            sessionId: "thread-session",
            totalTurns: 1,
            totalPromptTokens: 120,
            totalCompletionTokens: 30,
            totalTokens: 150,
            estimatedTotalCostUsd: 0.001,
            costTrackingAvailable: true,
            byModel: [],
            turns: [],
            budgetStatus: {
              configured: false,
              warnAtUsd: null,
              stopAtUsd: null,
              warningTriggered: false,
              stopTriggered: false,
              currentCostUsd: 0.001,
            },
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:01.000Z",
          },
        },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "budget_warning",
          sessionId: "thread-session",
          currentCostUsd: 0.001,
          thresholdUsd: 0.001,
          message: "warning threshold crossed",
        },
      },
      {
        ts: "2024-01-01T00:00:03.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "budget_exceeded",
          sessionId: "thread-session",
          currentCostUsd: 0.001,
          thresholdUsd: 0.001,
          message: "hard cap exceeded",
        },
      },
    ];

    await useAppStore.getState().selectThread(threadId);

    const rt = useAppStore.getState().threadRuntimeById[threadId];
    expect(rt?.lastTurnUsage).toEqual({
      turnId: "turn-1",
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cachedPromptTokens: 20,
        estimatedCostUsd: 0.0008,
      },
    });
    expect(rt?.sessionUsage?.totalTokens).toBe(150);
    expect(rt?.feed).toEqual([]);
  });

  test("ignores malformed transcript session_usage snapshots before reconnect", async () => {
    mockedTranscript = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "turn_usage",
          sessionId: "thread-session",
          turnId: "turn-1",
          usage: {
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 150,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "session_usage",
          sessionId: "thread-session",
          usage: {
            sessionId: "thread-session",
            totalTurns: 1,
          },
        },
      },
    ];

    await useAppStore.getState().selectThread(threadId);

    const rt = useAppStore.getState().threadRuntimeById[threadId];
    expect(rt?.lastTurnUsage?.usage.totalTokens).toBe(150);
    expect(rt?.sessionUsage).toBeNull();
    expect(rt?.feed).toEqual([]);
  });

  test("stores live usage events without adding unhandled feed noise", async () => {
    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);
    threadSocket.emit({
      type: "turn_usage",
      sessionId: "thread-session",
      turnId: "turn-2",
      usage: {
        promptTokens: 200,
        completionTokens: 50,
        totalTokens: 250,
        cachedPromptTokens: 40,
        estimatedCostUsd: 0.0014,
      },
    });
    threadSocket.emit({
      type: "session_usage",
      sessionId: "thread-session",
      usage: {
        sessionId: "thread-session",
        totalTurns: 2,
        totalPromptTokens: 320,
        totalCompletionTokens: 80,
        totalTokens: 400,
        estimatedTotalCostUsd: 0.002,
        costTrackingAvailable: true,
        byModel: [],
        turns: [],
        budgetStatus: {
          configured: true,
          warnAtUsd: 1,
          stopAtUsd: 5,
          warningTriggered: false,
          stopTriggered: false,
          currentCostUsd: 0.002,
        },
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:02.000Z",
      },
    });
    threadSocket.emit({
      type: "budget_warning",
      sessionId: "thread-session",
      currentCostUsd: 1.1,
      thresholdUsd: 1,
      message: "warning threshold crossed",
    });
    threadSocket.emit({
      type: "budget_exceeded",
      sessionId: "thread-session",
      currentCostUsd: 5.1,
      thresholdUsd: 5,
      message: "hard cap exceeded",
    });

    const state = useAppStore.getState();
    const rt = state.threadRuntimeById[activeThreadId];
    expect(rt?.lastTurnUsage?.usage.totalTokens).toBe(250);
    expect(rt?.lastTurnUsage?.usage.cachedPromptTokens).toBe(40);
    expect(rt?.lastTurnUsage?.usage.estimatedCostUsd).toBe(0.0014);
    expect(rt?.sessionUsage?.budgetStatus.warnAtUsd).toBe(1);
    expect(rt?.feed).toEqual([]);
    expect(state.notifications.map((item) => item.title)).toEqual([
      "Session budget warning",
      "Session hard cap exceeded",
    ]);
  });

  test("clearThreadUsageHardCap sends partial budget update for the active thread", async () => {
    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    useAppStore.setState((s) => ({
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [activeThreadId]: {
          ...s.threadRuntimeById[activeThreadId],
          sessionUsage: {
            sessionId: "thread-session",
            totalTurns: 1,
            totalPromptTokens: 100,
            totalCompletionTokens: 20,
            totalTokens: 120,
            estimatedTotalCostUsd: 5.5,
            costTrackingAvailable: true,
            byModel: [],
            turns: [],
            budgetStatus: {
              configured: true,
              warnAtUsd: 3,
              stopAtUsd: 5,
              warningTriggered: true,
              stopTriggered: true,
              currentCostUsd: 5.5,
            },
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:01.000Z",
          },
        },
      },
    }));

    useAppStore.getState().clearThreadUsageHardCap(activeThreadId);

    expect(threadSocket.sent).toContainEqual({
      type: "set_session_usage_budget",
      sessionId: "thread-session",
      stopAtUsd: null,
    });
  });

  test("sendMessage on a disconnected thread reconnects and sends in-place", async () => {
    await useAppStore.getState().selectThread(threadId);
    await useAppStore.getState().sendMessage("hello");

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    const sentUserMessages = threadSocket.sent.filter((m) => m && m.type === "user_message");
    expect(sentUserMessages.length).toBe(1);
    expect(sentUserMessages[0].text).toBe("hello");

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });
    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-1",
      outcome: "completed",
    });

    expect(threadSocket.sent.filter((m) => m && m.type === "user_message")).toHaveLength(1);

    const state = useAppStore.getState();
    expect(state.threads.find((t) => t.id === activeThreadId)?.status).toBe("active");
  });

  test("busy resume keeps reconnect firstMessage queued exactly once", async () => {
    await useAppStore.getState().selectThread(threadId);

    const initialSocket = socketByClient("desktop");
    emitServerHello(initialSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);
    initialSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });
    initialSocket.close();

    await useAppStore.getState().sendMessage("hello");

    const resumedSocket = socketByClient("desktop");
    resumedSocket.emit({
      type: "server_hello",
      sessionId: "thread-session",
      protocolVersion: "2.0",
      isResume: true,
      busy: true,
      turnId: "turn-1",
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });

    expect(resumedSocket.sent.filter((m) => m && m.type === "user_message")).toHaveLength(0);
    expect(RUNTIME.pendingThreadMessages.get(activeThreadId)).toEqual(["hello"]);

    resumedSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-1",
      outcome: "completed",
    });
    expect(resumedSocket.sent.filter((m) => m && m.type === "user_message")).toHaveLength(1);
    expect(resumedSocket.sent.filter((m) => m && m.type === "user_message")[0]?.text).toBe("hello");

    resumedSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-2",
      cause: "user_message",
    });
    resumedSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-2",
      outcome: "completed",
    });

    expect(resumedSocket.sent.filter((m) => m && m.type === "user_message")).toHaveLength(1);
  });

  test("reconnect keeps pending steers until the committed user_message arrives", async () => {
    await useAppStore.getState().selectThread(threadId);

    const initialSocket = socketByClient("desktop");
    emitServerHello(initialSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);
    initialSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    await useAppStore.getState().sendMessage("tighten the answer", "steer");

    const steerMessage = initialSocket.sent.find((msg) => msg?.type === "steer_message");
    expect(steerMessage?.clientMessageId).toBeTruthy();
    expect(RUNTIME.pendingThreadSteers.get(activeThreadId)?.has(steerMessage.clientMessageId)).toBe(true);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.pendingSteer).toEqual({
      clientMessageId: steerMessage!.clientMessageId,
      text: "tighten the answer",
      status: "sending",
    });

    initialSocket.close();

    expect(useAppStore.getState().threads.find((t) => t.id === activeThreadId)?.status).toBe("disconnected");
    expect(RUNTIME.pendingThreadSteers.get(activeThreadId)?.has(steerMessage.clientMessageId)).toBe(true);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.pendingSteer).toEqual({
      clientMessageId: steerMessage!.clientMessageId,
      text: "tighten the answer",
      status: "sending",
    });

    await useAppStore.getState().reconnectThread(activeThreadId);

    const resumedSocket = socketByClient("desktop");
    resumedSocket.emit({
      type: "server_hello",
      sessionId: "thread-session",
      protocolVersion: "2.0",
      isResume: true,
      busy: true,
      turnId: "turn-1",
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });

    expect(RUNTIME.pendingThreadSteers.get(activeThreadId)?.has(steerMessage.clientMessageId)).toBe(true);
    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.pendingSteer).toEqual({
      clientMessageId: steerMessage!.clientMessageId,
      text: "tighten the answer",
      status: "sending",
    });

    resumedSocket.emit({
      type: "steer_accepted",
      sessionId: "thread-session",
      turnId: "turn-1",
      text: "tighten the answer",
      clientMessageId: steerMessage.clientMessageId,
    });

    expect(useAppStore.getState().threadRuntimeById[activeThreadId]?.pendingSteer).toEqual({
      clientMessageId: steerMessage!.clientMessageId,
      text: "tighten the answer",
      status: "accepted",
    });

    resumedSocket.emit({
      type: "user_message",
      sessionId: "thread-session",
      text: "tighten the answer",
      clientMessageId: steerMessage.clientMessageId,
    });

    expect(RUNTIME.pendingThreadSteers.get(activeThreadId)?.has(steerMessage.clientMessageId) ?? false).toBe(false);
  });

  test("selectThread transcript hydration maps legacy reasoning aliases", async () => {
    mockedTranscript = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId,
        direction: "server",
        payload: { type: "assistant_reasoning", text: "legacy alias" },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId,
        direction: "server",
        payload: { type: "reasoning_summary", text: "legacy summary" },
      },
      {
        ts: "2024-01-01T00:00:02.000Z",
        threadId,
        direction: "server",
        payload: { type: "reasoning", kind: "summary", text: "current summary" },
      },
    ];

    await useAppStore.getState().selectThread(threadId);

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning).toHaveLength(3);
    expect(reasoning[0]?.text).toBe("legacy alias");
    expect(reasoning[1]?.text).toBe("legacy summary");
    expect(reasoning[2]?.text).toBe("current summary");
    expect(reasoning.map((item) => (item.kind === "reasoning" ? item.mode : ""))).toEqual([
      "reasoning",
      "summary",
      "summary",
    ]);
  });

  test("selectThread transcript hydration restores child agent summaries without feed noise", async () => {
    mockedTranscript = [
      {
        ts: "2024-01-01T00:00:00.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "agent_spawned",
          sessionId: "thread-session",
          agent: {
            agentId: "agent-1",
            parentSessionId: "thread-session",
            role: "research",
            mode: "collaborative",
            depth: 1,
            effectiveModel: "gpt-5.4",
            title: "Review notes",
            provider: "codex-cli",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            lifecycleState: "active",
            executionState: "running",
            busy: true,
          },
        },
      },
      {
        ts: "2024-01-01T00:00:01.000Z",
        threadId,
        direction: "server",
        payload: {
          type: "agent_status",
          sessionId: "thread-session",
          agent: {
            agentId: "agent-1",
            parentSessionId: "thread-session",
            role: "research",
            mode: "collaborative",
            depth: 1,
            effectiveModel: "gpt-5.4",
            title: "Review notes",
            provider: "codex-cli",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:01.000Z",
            lifecycleState: "active",
            executionState: "errored",
            busy: false,
            lastMessagePreview: "Failed to finish.",
          },
        },
      },
    ];

    await useAppStore.getState().selectThread(threadId);

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    expect(runtime?.agents).toHaveLength(1);
    expect(runtime?.agents[0]?.executionState).toBe("errored");
    expect(runtime?.agents[0]?.lastMessagePreview).toBe("Failed to finish.");
    expect(runtime?.feed).toEqual([]);
  });

  test("selectThread handles transcript read failures without crashing", async () => {
    mockedTranscriptError = new Error("boom");

    await expect(useAppStore.getState().selectThread(threadId)).resolves.toBeUndefined();

    const state = useAppStore.getState();
    expect(state.notifications.some((item) => item.title === "Transcript load failed")).toBe(true);
  });

  test("removeThread deletes both legacy and canonical transcript files after session rekey", async () => {
    const rekeyedThreadId = "thread-session";
    useAppStore.setState((state) => ({
      ...state,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              id: rekeyedThreadId,
              sessionId: rekeyedThreadId,
              legacyTranscriptId: threadId,
            }
          : thread,
      ),
      selectedThreadId: rekeyedThreadId,
    }));

    await useAppStore.getState().removeThread(rekeyedThreadId);

    expect(deleteTranscriptCalls).toEqual([threadId, rekeyedThreadId]);
  });

  test("sendMessage still appends transcript batches", async () => {
    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const activeThreadId = canonicalThreadId("thread-session", threadId);

    await useAppStore.getState().sendMessage("hello");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushAsyncWork();

    expect(
      appendTranscriptBatchCalls.flat().some((entry) =>
        entry.threadId === activeThreadId
        && entry.direction === "client"
        && (entry.payload as { type?: string }).type === "user_message"
      ),
    ).toBe(true);
  });
});
