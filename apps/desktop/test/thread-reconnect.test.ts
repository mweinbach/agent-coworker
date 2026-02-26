import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  url: string;
  client: string;
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
  getSystemAppearance: async () => "light",
  setWindowAppearance: async () => "light",
  onSystemAppearanceChanged: () => () => {},
  onMenuCommand: () => () => {},
}));

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: MockAgentSocket,
}));

const { useAppStore } = await import("../src/app/store");

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
    emitServerHello(threadSocket, "thread-session");

    const state = useAppStore.getState();
    const thread = state.threads.find((t) => t.id === threadId);
    expect(thread?.status).toBe("active");
    expect(state.threadRuntimeById[threadId]?.connected).toBe(true);
    expect(state.threadRuntimeById[threadId]?.sessionId).toBe("thread-session");
    expect(state.threadRuntimeById[threadId]?.transcriptOnly).toBe(false);
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
