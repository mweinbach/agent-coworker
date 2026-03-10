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

const MOCK_SOCKETS: MockAgentSocket[] = [];
let mockedTranscript: any[] = [];
let mockedTranscriptError: Error | null = null;
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
  loadState: async () => ({ version: 1, workspaces: [], threads: [] }),
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => {
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
const { RUNTIME } = await import("../src/app/store.helpers");

function socketByClient(client: string): MockAgentSocket {
  const socket = [...MOCK_SOCKETS].reverse().find((s) => s.opts.client === client);
  if (!socket) throw new Error(`Missing mock socket for client=${client}`);
  return socket;
}

function emitServerHello(socket: MockAgentSocket, sessionId: string) {
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
  });
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
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:00.000Z",
          status: "disconnected",
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
    expect(threadSocket.sent).toContainEqual({ type: "get_session_usage", sessionId: "thread-session" });

    const state = useAppStore.getState();
    const thread = state.threads.find((t) => t.id === threadId);
    expect(thread?.status).toBe("active");
    expect(state.threadRuntimeById[threadId]?.connected).toBe(true);
    expect(state.threadRuntimeById[threadId]?.sessionId).toBe("thread-session");
    expect(state.threadRuntimeById[threadId]?.transcriptOnly).toBe(false);
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
  });

  test("stores live usage events without adding unhandled feed noise", async () => {
    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
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

    const rt = useAppStore.getState().threadRuntimeById[threadId];
    expect(rt?.lastTurnUsage?.usage.totalTokens).toBe(250);
    expect(rt?.lastTurnUsage?.usage.cachedPromptTokens).toBe(40);
    expect(rt?.lastTurnUsage?.usage.estimatedCostUsd).toBe(0.0014);
    expect(rt?.sessionUsage?.budgetStatus.warnAtUsd).toBe(1);
    expect(rt?.feed).toEqual([]);
  });

  test("clearThreadUsageHardCap sends partial budget update for the active thread", async () => {
    await useAppStore.getState().selectThread(threadId);

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");

    useAppStore.setState((s) => ({
      threadRuntimeById: {
        ...s.threadRuntimeById,
        [threadId]: {
          ...s.threadRuntimeById[threadId],
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

    useAppStore.getState().clearThreadUsageHardCap(threadId);

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

    const sentUserMessages = threadSocket.sent.filter((m) => m && m.type === "user_message");
    expect(sentUserMessages.length).toBe(1);
    expect(sentUserMessages[0].text).toBe("hello");

    const state = useAppStore.getState();
    expect(state.threads.find((t) => t.id === threadId)?.status).toBe("active");
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

  test("selectThread handles transcript read failures without crashing", async () => {
    mockedTranscriptError = new Error("boom");

    await expect(useAppStore.getState().selectThread(threadId)).resolves.toBeUndefined();

    const state = useAppStore.getState();
    expect(state.notifications.some((item) => item.title === "Transcript load failed")).toBe(true);
  });
});
