import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  client: string;
  url?: string;
  onClose?: (reason: string) => void;
  onEvent?: (evt: any) => void;
};

class MockAgentSocket {
  sent: any[] = [];
  url?: string;

  constructor(public readonly opts: MockSocketOpts) {
    this.url = opts.url;
    MOCK_SOCKETS.push(this);
  }

  connect() {}

  send(message?: any) {
    this.sent.push(message);
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
const DESKTOP_STATE_CACHE_KEY = "cowork.desktop.state-cache.v2";
const storage = new Map<string, string>();
const localStorageMock = {
  getItem(key: string) {
    return storage.has(key) ? storage.get(key)! : null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
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

function installWindowMock() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: localStorageMock },
  });
}

function restoreWindowMock() {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>).window;
}

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

function canonicalThreadId(sessionId: string, fallbackThreadId?: string): string {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) =>
    item.id === sessionId
    || item.sessionId === sessionId
    || (fallbackThreadId ? item.legacyTranscriptId === fallbackThreadId : false),
  );
  return thread?.id ?? state.selectedThreadId ?? fallbackThreadId ?? sessionId;
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("desktop protocol v2 mapping", () => {
  let workspaceId = "";

  beforeEach(() => {
    installWindowMock();
    workspaceId = `ws-${crypto.randomUUID()}`;
    MOCK_SOCKETS.length = 0;
    localStorageMock.clear();
    RUNTIME.controlSockets.clear();
    RUNTIME.threadSockets.clear();
    RUNTIME.optimisticUserMessageIds.clear();
    RUNTIME.pendingThreadMessages.clear();
    RUNTIME.pendingThreadSteers.clear();
    RUNTIME.threadSelectionRequests.clear();
    RUNTIME.pendingWorkspaceDefaultApplyThreadIds.clear();
    RUNTIME.pendingWorkspaceDefaultApplyModeByThread.clear();
    RUNTIME.workspaceStartPromises.clear();
    RUNTIME.workspaceStartGenerations.clear();
    RUNTIME.modelStreamByThread.clear();
    RUNTIME.sessionSnapshots.clear();

    useAppStore.setState({
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
      selectedThreadId: null,
      threads: [],
      threadRuntimeById: {},
      workspaceRuntimeById: {},
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
      view: "chat",
      startupError: null,
      ready: true,
    });
  });

  afterAll(() => {
    restoreWindowMock();
  });

  test("control hello requests provider catalog/auth methods/status", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");

    emitServerHello(controlSocket, "control-session");

    const sentTypes = controlSocket.sent.map((msg) => msg?.type).filter(Boolean);
    expect(sentTypes).toContain("provider_catalog_get");
    expect(sentTypes).toContain("provider_auth_methods_get");
    expect(sentTypes).toContain("refresh_provider_status");
    expect(sentTypes).toContain("mcp_servers_get");
  });

  test("requestWorkspaceMemories waits for the initial control hello before surfacing not connected", async () => {
    const requestPromise = useAppStore.getState().requestWorkspaceMemories(workspaceId);
    await flushAsyncWork();
    const controlSocket = socketByClient("desktop-control");

    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.memoriesLoading).toBe(true);
    expect(useAppStore.getState().notifications).toHaveLength(0);

    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "memory_list",
      sessionId: "control-session",
      memories: [
        {
          id: "hot",
          scope: "workspace",
          content: "remember this",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    await requestPromise;

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.memoriesLoading).toBe(false);
    expect(runtime?.memories).toHaveLength(1);
    expect(useAppStore.getState().notifications).toHaveLength(0);

    const memoryListMessages = controlSocket.sent.filter((msg) => msg?.type === "memory_list");
    expect(memoryListMessages).toHaveLength(1);
  });

  test("closing a pending initial control connection clears memory loading and reports not connected", async () => {
    const requestPromise = useAppStore.getState().requestWorkspaceMemories(workspaceId);
    await flushAsyncWork();
    const controlSocket = socketByClient("desktop-control");

    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.memoriesLoading).toBe(true);

    controlSocket.close();
    await requestPromise;

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.memoriesLoading).toBe(false);

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Not connected");
    expect(notification?.detail).toBe("Unable to request memories.");
  });

  test("sessions events reconcile legacy desktop thread ids to harness session ids", async () => {
    useAppStore.setState((state) => ({
      ...state,
      threads: [
        {
          id: "local-thread-id",
          workspaceId,
          title: "Legacy Thread",
          titleSource: "manual",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:00.000Z",
          status: "disconnected",
          sessionId: null,
          messageCount: 0,
          lastEventSeq: 0,
        },
      ],
      selectedThreadId: "local-thread-id",
      threadRuntimeById: {
        "local-thread-id": {
          sessionId: "thread-session",
          connected: false,
        } as any,
      },
    }));

    await useAppStore.getState().selectWorkspace(workspaceId);
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "sessions",
      sessionId: "control-session",
      sessions: [
        {
          sessionId: "thread-session",
          title: "Harness Thread",
          titleSource: "model",
          titleModel: "gpt-5.2",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:10.000Z",
          messageCount: 5,
          lastEventSeq: 9,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      ],
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === "thread-session");
    expect(thread).toBeDefined();
    expect(thread?.legacyTranscriptId).toBe("local-thread-id");
    expect(useAppStore.getState().selectedThreadId).toBe("thread-session");
  });

  test("sessions events preserve drafts when a server thread claims the same legacy transcript id", async () => {
    useAppStore.setState((state) => ({
      ...state,
      threads: [
        {
          id: "thread-session",
          workspaceId,
          title: "Server Thread",
          titleSource: "model",
          createdAt: "2024-01-01T00:00:00.000Z",
          lastMessageAt: "2024-01-01T00:00:10.000Z",
          status: "disconnected",
          sessionId: "thread-session",
          messageCount: 5,
          lastEventSeq: 9,
          legacyTranscriptId: "draft-thread-id",
          draft: false,
        },
        {
          id: "draft-thread-id",
          workspaceId,
          title: "Draft Thread",
          titleSource: "default",
          createdAt: "2024-01-01T00:00:05.000Z",
          lastMessageAt: "2024-01-01T00:00:05.000Z",
          status: "disconnected",
          sessionId: null,
          messageCount: 0,
          lastEventSeq: 0,
          draft: true,
        },
      ],
      selectedThreadId: "draft-thread-id",
    }));

    await useAppStore.getState().selectWorkspace(workspaceId);
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "sessions",
      sessionId: "control-session",
      sessions: [
        {
          sessionId: "thread-session",
          title: "Server Thread",
          titleSource: "model",
          titleModel: "gpt-5.2",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:10.000Z",
          messageCount: 5,
          lastEventSeq: 9,
          hasPendingAsk: false,
          hasPendingApproval: false,
        },
      ],
    });

    const threads = useAppStore.getState().threads;
    expect(threads.find((thread) => thread.id === "draft-thread-id")?.draft).toBe(true);
    expect(threads.find((thread) => thread.id === "thread-session")?.legacyTranscriptId).toBe("draft-thread-id");
    expect(useAppStore.getState().selectedThreadId).toBe("draft-thread-id");
  });

  test("draft threads stay local until the first message promotes them into a real session", async () => {
    await useAppStore.getState().newThread();
    const draftThreadId = useAppStore.getState().selectedThreadId!;

    expect(MOCK_SOCKETS).toHaveLength(0);
    expect(useAppStore.getState().threads.find((thread) => thread.id === draftThreadId)?.draft).toBe(true);

    await useAppStore.getState().sendMessage("hello from draft");
    await flushAsyncWork();

    const controlSocket = socketByClient("desktop-control");
    expect(controlSocket).toBeDefined();

    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");

    const sentMessages = threadSocket.sent.filter((msg) => msg?.type === "user_message");
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toBe("hello from draft");

    const threadId = canonicalThreadId("thread-session", draftThreadId);
    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.draft).toBe(false);
    expect(thread?.sessionId).toBe("thread-session");
  });

  test("stores activeTurnId from resumed busy hello and live session_busy events", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId!;
    const threadSocket = socketByClient("desktop");

    threadSocket.emit({
      type: "server_hello",
      sessionId: "thread-session",
      isResume: true,
      busy: true,
      turnId: "turn-resume",
      protocolVersion: "2.0",
      config: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/tmp/workspace",
        outputDirectory: "/tmp/workspace/output",
      },
    });
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    expect(useAppStore.getState().threadRuntimeById[threadId]?.activeTurnId).toBe("turn-resume");

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-live",
      cause: "user_message",
    });
    expect(useAppStore.getState().threadRuntimeById[threadId]?.activeTurnId).toBe("turn-live");

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-live",
      outcome: "completed",
    });
    expect(useAppStore.getState().threadRuntimeById[threadId]?.activeTurnId).toBeNull();
  });

  test("queues exactly one next-turn message per session_busy false transition", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const threadId = useAppStore.getState().selectedThreadId!;
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    await useAppStore.getState().sendMessage("queued one", "queue");
    await useAppStore.getState().sendMessage("queued two", "queue");

    expect(threadSocket.sent.filter((msg) => msg?.type === "user_message")).toHaveLength(0);

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-1",
      outcome: "completed",
    });

    const firstFlush = threadSocket.sent.filter((msg) => msg?.type === "user_message");
    expect(firstFlush).toHaveLength(1);
    expect(firstFlush[0]?.text).toBe("queued one");

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-2",
      cause: "user_message",
    });
    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: false,
      turnId: "turn-2",
      outcome: "completed",
    });

    const secondFlush = threadSocket.sent.filter((msg) => msg?.type === "user_message");
    expect(secondFlush).toHaveLength(2);
    expect(secondFlush[1]?.text).toBe("queued two");
  });

  test("busy steer sends steer_message with activeTurnId and tracks acceptance separately from queued messages", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId!;
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    useAppStore.setState({ composerText: "tighten the answer" });
    await useAppStore.getState().sendMessage("tighten the answer", "steer");

    const steerMessage = threadSocket.sent.find((msg) => msg?.type === "steer_message");
    expect(steerMessage).toBeDefined();
    expect(steerMessage?.expectedTurnId).toBe("turn-1");
    expect(steerMessage?.clientMessageId).toBeTruthy();
    expect(useAppStore.getState().composerText).toBe("tighten the answer");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingSteer).toEqual({
      clientMessageId: steerMessage!.clientMessageId,
      text: "tighten the answer",
      status: "sending",
    });
    expect(RUNTIME.pendingThreadMessages.get(threadId)?.length ?? 0).toBe(0);
    expect(RUNTIME.pendingThreadSteers.get(threadId)?.get(steerMessage.clientMessageId)?.accepted).toBe(false);

    threadSocket.emit({
      type: "steer_accepted",
      sessionId: "thread-session",
      turnId: "turn-1",
      text: "tighten the answer",
      clientMessageId: steerMessage.clientMessageId,
    });
    expect(RUNTIME.pendingThreadSteers.get(threadId)?.get(steerMessage.clientMessageId)?.accepted).toBe(true);
    expect(useAppStore.getState().composerText).toBe("");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingSteer?.status).toBe("accepted");

    threadSocket.emit({
      type: "user_message",
      sessionId: "thread-session",
      text: "tighten the answer",
      clientMessageId: steerMessage.clientMessageId,
    });
    expect(RUNTIME.pendingThreadSteers.get(threadId)?.has(steerMessage.clientMessageId) ?? false).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingSteer).toBeNull();
  });

  test("busy steer keeps the composer text when the server rejects the steer", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId!;
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    useAppStore.setState({ composerText: "tighten the answer" });
    await useAppStore.getState().sendMessage("tighten the answer", "steer");

    expect(useAppStore.getState().composerText).toBe("tighten the answer");

    threadSocket.emit({
      type: "error",
      sessionId: "thread-session",
      message: "Active turn mismatch.",
      code: "validation_failed",
      source: "session",
    });

    expect(useAppStore.getState().composerText).toBe("tighten the answer");
    expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingSteer).toBeNull();
  });

  test("busy steer ignores duplicate submits while the same draft is still pending", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId!;
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    useAppStore.setState({ composerText: "tighten the answer" });
    await useAppStore.getState().sendMessage("tighten the answer", "steer");
    await useAppStore.getState().sendMessage("tighten the answer", "steer");

    const steerMessages = threadSocket.sent.filter((msg) => msg?.type === "steer_message");
    expect(steerMessages).toHaveLength(1);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.pendingSteer).toEqual({
      clientMessageId: steerMessages[0]!.clientMessageId,
      text: "tighten the answer",
      status: "sending",
    });
  });

  test("requestWorkspaceMemories replaces a stale control socket when the workspace server URL changes", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const originalSocket = socketByClient("desktop-control");
    emitServerHello(originalSocket, "old-control-session");

    useAppStore.setState((state) => ({
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          serverUrl: "ws://replacement",
        },
      },
    }));

    const requestPromise = useAppStore.getState().requestWorkspaceMemories(workspaceId);
    await flushAsyncWork();

    const replacementSocket = socketByClient("desktop-control");
    expect(replacementSocket).not.toBe(originalSocket);
    expect(originalSocket.opts.url).toBe("ws://mock");
    expect(replacementSocket.opts.url).toBe("ws://replacement");

    const runtimeWhileConnecting = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtimeWhileConnecting?.controlSessionId).toBeNull();
    expect(runtimeWhileConnecting?.memoriesLoading).toBe(true);
    expect(replacementSocket.sent.filter((msg) => msg?.type === "memory_list")).toHaveLength(0);

    emitServerHello(replacementSocket, "replacement-session");
    replacementSocket.emit({
      type: "memory_list",
      sessionId: "replacement-session",
      memories: [],
    });
    await requestPromise;

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.controlSessionId).toBe("replacement-session");
    expect(runtime?.memoriesLoading).toBe(false);
    expect(useAppStore.getState().notifications).toHaveLength(0);
    expect(replacementSocket.sent.filter((msg) => msg?.type === "memory_list")).toHaveLength(1);
  });

  test("mcp events update runtime slices and notifications", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

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
        workspace: { path: "/tmp/workspace/.agent/mcp-servers.json", exists: false },
        user: { path: "/tmp/home/.agent/mcp-servers.json", exists: false },
      },
      files: [],
    });
    controlSocket.emit({
      type: "mcp_server_validation",
      sessionId: "control-session",
      name: "grep",
      ok: false,
      mode: "missing",
      message: "OAuth required.",
    });
    controlSocket.emit({
      type: "mcp_server_auth_result",
      sessionId: "control-session",
      name: "grep",
      ok: false,
      mode: "error",
      message: "Auth failed.",
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.mcpServers[0]?.name).toBe("grep");
    expect(runtime?.mcpValidationByName.grep?.ok).toBe(false);
    expect(runtime?.mcpLastAuthResult?.name).toBe("grep");

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("MCP auth failed: grep");
  });

  test("workspace_backups event hydrates the workspace runtime slice", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "workspace_backups",
      sessionId: "control-session",
      workspacePath: "/tmp/workspace",
      backups: [
        {
          targetSessionId: "thread-session",
          title: "Deleted session",
          provider: "openai",
          model: "gpt-5.2",
          lifecycle: "deleted",
          status: "ready",
          workingDirectory: "/tmp/workspace",
          backupDirectory: "/tmp/home/.cowork/session-backups/thread-session",
          originalSnapshotKind: "directory",
          originalSnapshotBytes: 4096,
          checkpointBytesTotal: 2048,
          totalBytes: 6144,
          checkpoints: [
            {
              id: "cp-0001",
              index: 1,
              createdAt: "2026-03-10T00:01:00.000Z",
              trigger: "manual",
              changed: true,
              patchBytes: 2048,
            },
          ],
          createdAt: "2026-03-10T00:00:00.000Z",
          updatedAt: "2026-03-10T00:02:00.000Z",
        },
      ],
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.workspaceBackupsPath).toBe("/tmp/workspace");
    expect(runtime?.workspaceBackups).toHaveLength(1);
    expect(runtime?.workspaceBackups[0]?.targetSessionId).toBe("thread-session");
    expect(runtime?.workspaceBackups[0]?.checkpoints[0]?.id).toBe("cp-0001");
  });

  test("workspace_backup_delta event hydrates the workspace delta slice", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "workspace_backup_delta",
      sessionId: "control-session",
      targetSessionId: "thread-session",
      checkpointId: "cp-0001",
      baselineLabel: "Original snapshot",
      currentLabel: "cp-0001",
      counts: {
        added: 1,
        modified: 1,
        deleted: 0,
      },
      files: [
        { path: "src/new.ts", change: "added", kind: "file" },
        { path: "README.md", change: "modified", kind: "file" },
      ],
      truncated: false,
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.workspaceBackupDelta?.checkpointId).toBe("cp-0001");
    expect(runtime?.workspaceBackupDelta?.counts.modified).toBe(1);
    expect(runtime?.workspaceBackupDelta?.files[0]?.path).toBe("src/new.ts");
  });

  test("workspace backup actions send control-session messages", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    const threadSocket = socketByClient("desktop");
    emitServerHello(threadSocket, "thread-session");
    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().requestWorkspaceBackups(workspaceId);
    await useAppStore.getState().requestWorkspaceBackupDelta(workspaceId, "thread-session", "cp-0001");
    await useAppStore.getState().createWorkspaceBackupCheckpoint(workspaceId, "thread-session");
    await useAppStore.getState().restoreWorkspaceBackupOriginal(workspaceId, "thread-session");
    await useAppStore.getState().restoreWorkspaceBackupCheckpoint(workspaceId, "thread-session", "cp-0001");
    await useAppStore.getState().deleteWorkspaceBackupCheckpoint(workspaceId, "thread-session", "cp-0001");
    await useAppStore.getState().deleteWorkspaceBackupEntry(workspaceId, "thread-session");
    await useAppStore.getState().setWorkspaceBackupSessionEnabled(workspaceId, "thread-session", false);

    const sentTypes = controlSocket.sent.map((msg) => msg?.type).filter(Boolean);
    expect(sentTypes).toContain("workspace_backups_get");
    expect(sentTypes).toContain("workspace_backup_delta_get");
    expect(sentTypes).toContain("workspace_backup_checkpoint");
    expect(sentTypes).toContain("workspace_backup_restore");
    expect(sentTypes).toContain("workspace_backup_delete_checkpoint");
    expect(sentTypes).toContain("workspace_backup_delete_entry");

    const checkpointRestore = controlSocket.sent.find(
      (msg) => msg?.type === "workspace_backup_restore" && msg?.checkpointId === "cp-0001",
    );
    expect(checkpointRestore?.targetSessionId).toBe("thread-session");

    const checkpointDelta = controlSocket.sent.find(
      (msg) => msg?.type === "workspace_backup_delta_get" && msg?.checkpointId === "cp-0001",
    );
    expect(checkpointDelta?.targetSessionId).toBe("thread-session");

    const deleteEntry = controlSocket.sent.find((msg) => msg?.type === "workspace_backup_delete_entry");
    expect(deleteEntry?.targetSessionId).toBe("thread-session");

    const toggleBackups = threadSocket.sent.find((msg) => msg?.type === "set_config");
    expect(toggleBackups).toMatchObject({
      type: "set_config",
      config: {
        backupsEnabled: false,
      },
    });
  });

  test("control errors clear memory loading when memory_list fails", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    await useAppStore.getState().requestWorkspaceMemories(workspaceId);
    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.memoriesLoading).toBe(true);

    controlSocket.emit({
      type: "error",
      sessionId: "control-session",
      message: "Failed to list memories: SQLITE_CORRUPT",
      code: "internal_error",
      source: "session",
    });

    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtime?.memoriesLoading).toBe(false);

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Control session error");
    expect(notification?.detail).toContain("session/internal_error");
  });

  test("connectProvider sends provider_auth_set_api_key for keyed providers", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().connectProvider("openai", "sk-test");

    const sent = controlSocket.sent.find((msg) => msg?.type === "provider_auth_set_api_key");
    expect(sent).toBeDefined();
    expect(sent?.provider).toBe("openai");
    expect(sent?.methodId).toBe("api_key");
    expect(sent?.apiKey).toBe("sk-test");
  });

  test("copyProviderApiKey sends provider_auth_copy_api_key", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().copyProviderApiKey("opencode-zen", "opencode-go");

    const sent = controlSocket.sent.find((msg) => msg?.type === "provider_auth_copy_api_key");
    expect(sent).toBeDefined();
    expect(sent?.provider).toBe("opencode-zen");
    expect(sent?.sourceProvider).toBe("opencode-go");
  });

  test("connectProvider sends oauth authorize+callback for oauth providers", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().connectProvider("codex-cli");

    const sentTypes = controlSocket.sent.map((msg) => msg?.type).filter(Boolean);
    expect(sentTypes).toContain("provider_auth_authorize");
    expect(sentTypes).toContain("provider_auth_callback");
  });

  test("logoutProviderAuth sends provider_auth_logout", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.sent = [];

    await useAppStore.getState().logoutProviderAuth("codex-cli");

    const sent = controlSocket.sent.find((msg) => msg?.type === "provider_auth_logout");
    expect(sent).toBeDefined();
    expect(sent?.provider).toBe("codex-cli");
  });

  test("provider auth challenge keeps command metadata for desktop UI", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "provider_auth_challenge",
      sessionId: "control-session",
      provider: "codex-cli",
      methodId: "oauth_cli",
      challenge: {
        method: "auto",
        instructions: "The app will open Cowork's Codex sign-in URL automatically.",
        url: "https://auth.openai.com/oauth/authorize",
        command: "optional-command",
      },
    });

    const challenge = useAppStore.getState().providerLastAuthChallenge;
    expect(challenge).toBeDefined();
    expect(challenge?.challenge.url).toBeUndefined();
    expect(challenge?.challenge.command).toBe("optional-command");

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Auth challenge: codex-cli");
    expect(notification?.detail).toContain("Command: optional-command");
  });

  test("provider auth result with oauth_pending uses pending notification title", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "provider_auth_result",
      sessionId: "control-session",
      provider: "codex-cli",
      methodId: "oauth_cli",
      ok: true,
      mode: "oauth_pending",
      message: "Complete sign-in in terminal.",
    });

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Provider auth pending: codex-cli");
    expect(notification?.detail).toBe("Complete sign-in in terminal.");
  });

  test("provider auth logout result uses disconnected notification title", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    controlSocket.emit({
      type: "provider_auth_result",
      sessionId: "control-session",
      provider: "codex-cli",
      methodId: "logout",
      ok: true,
      message: "Codex OAuth credentials cleared.",
    });

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Provider disconnected: codex-cli");
    expect(notification?.detail).toBe("Codex OAuth credentials cleared.");
  });

  test("approval prompt keeps required reasonCode", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "approval",
      sessionId: "thread-session",
      requestId: "req-1",
      command: "cat /etc/passwd",
      dangerous: false,
      reasonCode: "outside_allowed_scope",
    });

    const modal = useAppStore.getState().promptModal;
    expect(modal?.kind).toBe("approval");
    if (!modal || modal.kind !== "approval") throw new Error("Expected approval modal");
    expect(modal.prompt.reasonCode).toBe("outside_allowed_scope");
  });

  test("session_info updates canonical thread title", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "Session title from server",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.title).toBe("Session title from server");
  });

  test("non-manual session_info titles are applied once", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "First generated title",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "Second generated title",
      titleSource: "heuristic",
      titleModel: null,
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:02.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.title).toBe("First generated title");
    expect(thread?.titleSource).toBe("model");
  });

  test("manual local rename is not overwritten by non-manual session_info", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    useAppStore.getState().renameThread(initialThreadId, "My Manual Title");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "session_info",
      sessionId: "thread-session",
      title: "Generated Title",
      titleSource: "model",
      titleModel: "gpt-5-mini",
      createdAt: "2026-02-19T00:00:00.000Z",
      updatedAt: "2026-02-19T00:00:01.000Z",
      provider: "openai",
      model: "gpt-5.2",
    });

    const thread = useAppStore.getState().threads.find((item) => item.id === threadId);
    expect(thread?.title).toBe("My Manual Title");
    expect(thread?.titleSource).toBe("manual");
  });

  test("error feed + notification keep required source/code", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "error",
      sessionId: "thread-session",
      message: "Blocked: path is outside allowed roots",
      code: "permission_denied",
      source: "permissions",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const last = feed.at(-1);
    expect(last?.kind).toBe("error");
    if (!last || last.kind !== "error") throw new Error("Expected error feed item");
    expect(last.code).toBe("permission_denied");
    expect(last.source).toBe("permissions");

    const notif = useAppStore.getState().notifications.at(-1);
    expect(notif?.title).toBe("Agent error");
    expect(notif?.detail).toContain("permissions/permission_denied");
  });

  test("model_stream_chunk updates assistant/reasoning/tool feed and dedupes legacy finals", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "Hel" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "lo" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 2,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: { id: "r1", mode: "summary", text: "thinking" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 3,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_call",
      part: { toolCallId: "tool-1", toolName: "read", input: { path: "README.md" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-1",
      index: 4,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_result",
      part: { toolCallId: "tool-1", toolName: "read", output: { chars: 42 } },
    });

    // Legacy compatibility events still arrive; these should be deduped.
    threadSocket.emit({
      type: "reasoning",
      sessionId: "thread-session",
      kind: "summary",
      text: "thinking",
    });
    threadSocket.emit({
      type: "assistant_message",
      sessionId: "thread-session",
      text: "Hello",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const assistant = feed.filter((item) => item.kind === "message" && item.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe("Hello");

    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.mode).toBe("summary");
    expect(reasoning[0]?.text).toBe("thinking");

    expect(feed.map((item) => item.kind)).toEqual(["message", "reasoning", "tool"]);

    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("read");
    expect(tool.state).toBe("output-available");
    expect(tool.result).toEqual({ chars: 42 });
  });

  test("repeated same-turn start chunks do not re-enable legacy reasoning duplicates", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-google-1",
      index: 0,
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      partType: "start",
      part: {},
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-google-1",
      index: 1,
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      partType: "reasoning_delta",
      part: { id: "s0", mode: "reasoning", text: "Searching for the latest GTC details." },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-google-1",
      index: 2,
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      partType: "tool_call",
      part: { toolCallId: "tool-1", toolName: "webSearch", input: { query: "NVIDIA GTC 2026" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-google-1",
      index: 3,
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      partType: "tool_result",
      part: { toolCallId: "tool-1", toolName: "webSearch", output: "result" },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-google-1",
      index: 4,
      provider: "google",
      model: "gemini-3.1-pro-preview-customtools",
      partType: "start",
      part: {},
    });

    threadSocket.emit({
      type: "reasoning",
      sessionId: "thread-session",
      kind: "reasoning",
      text: "Searching for the latest GTC details.",
    });
    threadSocket.emit({
      type: "assistant_message",
      sessionId: "thread-session",
      text: "Here is the summary.",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const reasoning = feed.filter((item) => item.kind === "reasoning");

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("Searching for the latest GTC details.");
    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "tool", "message"]);
  });

  test("model_stream_raw drives live feed replay and suppresses stale normalized reasoning chunks", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "model_stream_raw",
      sessionId: "thread-session",
      turnId: "turn-raw",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "reasoning", id: "rs_live", summary: [] },
      },
    });
    threadSocket.emit({
      type: "model_stream_raw",
      sessionId: "thread-session",
      turnId: "turn-raw",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.reasoning_summary_part.added",
        part: { text: "" },
      },
    });
    threadSocket.emit({
      type: "model_stream_raw",
      sessionId: "thread-session",
      turnId: "turn-raw",
      index: 2,
      provider: "openai",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.reasoning_summary_text.delta",
        delta: "live raw reasoning",
      },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-raw",
      index: 3,
      provider: "openai",
      model: "gpt-5.2",
      partType: "reasoning_delta",
      part: { id: "stale-r1", mode: "summary", text: "stale normalized reasoning" },
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const reasoning = feed.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe("live raw reasoning");
  });

  test("late reasoning summaries stay ahead of the raw-backed final assistant message", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "model_stream_raw",
      sessionId: "thread-session",
      turnId: "turn-late-reasoning",
      index: 0,
      provider: "codex-cli",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_item.added",
        item: { type: "message", id: "msg_final", phase: "final_answer", content: [] },
      },
    });
    threadSocket.emit({
      type: "model_stream_raw",
      sessionId: "thread-session",
      turnId: "turn-late-reasoning",
      index: 1,
      provider: "codex-cli",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.content_part.added",
        item_id: "msg_final",
        part: { type: "output_text", text: "" },
      },
    });
    threadSocket.emit({
      type: "model_stream_raw",
      sessionId: "thread-session",
      turnId: "turn-late-reasoning",
      index: 2,
      provider: "codex-cli",
      model: "gpt-5.2",
      format: "openai-responses-v1",
      normalizerVersion: 1,
      event: {
        type: "response.output_text.delta",
        item_id: "msg_final",
        delta: "final answer",
      },
    });

    threadSocket.emit({
      type: "reasoning",
      sessionId: "thread-session",
      kind: "summary",
      text: "late summary",
    });
    threadSocket.emit({
      type: "assistant_message",
      sessionId: "thread-session",
      text: "final answer",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    expect(feed.map((item) => item.kind)).toEqual(["reasoning", "message"]);
    expect(feed[0]?.kind).toBe("reasoning");
    expect(feed[1]?.kind).toBe("message");
    if (feed[0]?.kind !== "reasoning") throw new Error("Expected reasoning first");
    if (feed[1]?.kind !== "message") throw new Error("Expected assistant message second");
    expect(feed[0].text).toBe("late summary");
    expect(feed[1].text).toBe("final answer");
  });

  test("model stream approval parts render as tool cards while source/file/unknown parts stay in system items", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "tool_approval_request",
      part: { approvalId: "ap-1", toolCall: { toolName: "bash" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "source",
      part: { source: { type: "url", url: "https://example.com" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 2,
      provider: "openai",
      model: "gpt-5.2",
      partType: "file",
      part: { file: { path: "/tmp/a.txt" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 3,
      provider: "openai",
      model: "gpt-5.2",
      partType: "raw",
      part: { raw: { type: "provider_event" } },
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-2",
      index: 4,
      provider: "openai",
      model: "gpt-5.2",
      partType: "future_part",
      part: { payload: true },
    } as any);

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("bash");
    expect(tool.state).toBe("approval-requested");
    expect(tool.approval).toEqual({
      approvalId: "ap-1",
      toolCall: { toolName: "bash" },
    });

    const systemLines = feed
      .filter((item) => item.kind === "system")
      .map((item) => (item.kind === "system" ? item.line : ""));

    expect(systemLines.some((line) => line.includes("Source:"))).toBe(true);
    expect(systemLines.some((line) => line.includes("File:"))).toBe(true);
    expect(systemLines.some((line) => line.includes("Unhandled stream part (future_part)"))).toBe(true);
  });

  test("raw function-call argument deltas become readable tool args and names", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-3",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "raw",
      part: {
        raw: {
          type: "response.function_call_arguments.delta",
          item_id: "fc_ask_1",
          delta: "{\"question\":\"What next?\",\"options\":[\"Ship fix\",\"Run tests\"]}",
        },
      },
    });

    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "thread-session",
      turnId: "turn-3",
      index: 1,
      provider: "openai",
      model: "gpt-5.2",
      partType: "raw",
      part: {
        raw: {
          type: "response.function_call_arguments.done",
          item_id: "fc_ask_1",
          tool_name: "ask",
        },
      },
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const tool = feed.find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") throw new Error("Expected tool feed item");
    expect(tool.name).toBe("ask");
    expect(tool.args).toEqual({
      question: "What next?",
      options: ["Ship fix", "Run tests"],
    });
  });

  test("ignores stale session events for control and thread sockets", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    const feedBefore = useAppStore.getState().threadRuntimeById[threadId]?.feed.length ?? 0;

    threadSocket.emit({
      type: "assistant_message",
      sessionId: "stale-thread-session",
      text: "should be ignored",
    });
    threadSocket.emit({
      type: "model_stream_chunk",
      sessionId: "stale-thread-session",
      turnId: "stale-turn",
      index: 0,
      provider: "openai",
      model: "gpt-5.2",
      partType: "text_delta",
      part: { id: "txt_1", text: "ignored" },
    });

    const feedAfter = useAppStore.getState().threadRuntimeById[threadId]?.feed.length ?? 0;
    expect(feedAfter).toBe(feedBefore);

    controlSocket.emit({
      type: "provider_status",
      sessionId: "stale-control-session",
      providers: [
        {
          provider: "openai",
          connected: true,
          authorized: true,
          authMode: "api_key",
          accountLabel: "user@example.com",
          modelCount: 1,
          source: "env",
        },
      ],
    } as any);

    expect(useAppStore.getState().providerConnected).toEqual([]);
  });

  test("verified-only local providers stay in providerConnected", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const controlSocket = socketByClient("desktop-control");

    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "provider_status",
      sessionId: "control-session",
      providers: [
        {
          provider: "lmstudio",
          authorized: false,
          verified: true,
          mode: "local",
          account: null,
          message: "LM Studio reachable",
          checkedAt: new Date().toISOString(),
        },
      ],
    } as any);

    expect(useAppStore.getState().providerConnected).toEqual(["lmstudio"]);
  });

  test("legacy log events still map to log feed items when no model stream exists", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "log",
      sessionId: "thread-session",
      line: "tool> read {\"path\":\"README.md\"}",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    const last = feed.at(-1);
    expect(last?.kind).toBe("log");
    if (!last || last.kind !== "log") throw new Error("Expected log feed item");
    expect(last.line).toContain("tool> read");
  });

  test("suppresses raw provider debug log lines", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");

    threadSocket.emit({
      type: "log",
      sessionId: "thread-session",
      line: "raw stream part: {\"type\":\"response.function_call_arguments.delta\"}",
    });

    const feed = useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [];
    expect(feed.some((item) => item.kind === "log")).toBe(false);
  });

  test("developer diagnostics server events become readable system notices", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);

    threadSocket.emit({
      type: "observability_status",
      sessionId: "thread-session",
      enabled: true,
      health: { status: "ready", reason: "runtime_ready" },
      config: {
        provider: "langfuse",
        baseUrl: "https://example.com",
        otelEndpoint: "https://example.com/otel",
        hasPublicKey: true,
        hasSecretKey: true,
        configured: true,
      },
    });
    threadSocket.emit({
      type: "session_backup_state",
      sessionId: "thread-session",
      reason: "auto_checkpoint",
      backup: {
        status: "ready",
        checkpoints: [{ id: "cp-1" }],
      },
    });
    threadSocket.emit({
      type: "harness_context",
      sessionId: "thread-session",
      context: {
        taskId: "task-1",
        runId: "run-1",
        objective: "Ship it.",
        acceptanceCriteria: ["a"],
        constraints: ["b", "c"],
      },
    });

    const systemLines = (useAppStore.getState().threadRuntimeById[threadId]?.feed ?? [])
      .filter((item) => item.kind === "system")
      .map((item) => (item.kind === "system" ? item.line : ""));

    expect(systemLines).toContain("Observability: enabled=yes, configured=yes, health=ready (runtime_ready)");
    expect(systemLines).toContain("Session backup (auto checkpoint): status=ready, checkpoints=1");
    expect(systemLines).toContain(
      "Harness context updated: taskId=task-1, runId=run-1, objective=Ship it., acceptanceCriteria=1, constraints=2",
    );
  });

  test("manual cancel sends cancel only and does not auto-reset busy state", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);
    threadSocket.sent = [];

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    useAppStore.getState().cancelThread(threadId);

    expect(threadSocket.sent.some((msg) => msg?.type === "cancel")).toBe(true);
    expect(threadSocket.sent.some((msg) => msg?.type === "session_close")).toBe(false);
    expect(useAppStore.getState().threadRuntimeById[threadId]?.busy).toBe(true);
  });

  test("manual cancel can request stopping subagents too", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);
    threadSocket.sent = [];

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-1",
      cause: "user_message",
    });

    useAppStore.getState().cancelThread(threadId, { includeSubagents: true });

    expect(threadSocket.sent).toContainEqual({
      type: "cancel",
      sessionId: "thread-session",
      includeSubagents: true,
    });
  });

  test("session_busy does not trigger automatic cancel", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    threadSocket.sent = [];

    threadSocket.emit({
      type: "session_busy",
      sessionId: "thread-session",
      busy: true,
      turnId: "turn-2",
      cause: "user_message",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(threadSocket.sent.some((msg) => msg?.type === "cancel")).toBe(false);
    expect(
      useAppStore
        .getState()
        .notifications.some((n) => n.detail?.includes("Attempting automatic cancel"))
    ).toBe(false);
  });

  test("removeThread sends session_close for connected thread sessions", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);
    threadSocket.sent = [];

    await useAppStore.getState().removeThread(threadId);

    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
  });

  test("removeThread purges cached session snapshots from desktop state cache", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);
    RUNTIME.sessionSnapshots.set("thread-session", {
      fingerprint: {
        updatedAt: "2024-01-01T00:00:02.000Z",
        messageCount: 2,
        lastEventSeq: 4,
      },
      snapshot: {
        sessionId: "thread-session",
        title: "Cached Thread",
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
        lastMessagePreview: "Hello from cache",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:02.000Z",
        messageCount: 2,
        lastEventSeq: 4,
        feed: [],
        agents: [],
        todos: [],
        sessionUsage: null,
        lastTurnUsage: null,
        hasPendingAsk: false,
        hasPendingApproval: false,
      },
    });
    threadSocket.sent = [];

    await useAppStore.getState().removeThread(threadId);

    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
    expect(RUNTIME.sessionSnapshots.has("thread-session")).toBe(false);
    const cachedState = localStorageMock.getItem(DESKTOP_STATE_CACHE_KEY);
    expect(cachedState).not.toBeNull();
    expect(JSON.parse(cachedState!).sessionSnapshots?.["thread-session"]).toBeUndefined();
  });

  test("deleteThreadHistory sends delete_session via control socket after closing thread session", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const initialThreadId = useAppStore.getState().selectedThreadId;
    if (!initialThreadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    const threadId = canonicalThreadId("thread-session", initialThreadId);
    RUNTIME.sessionSnapshots.set("thread-session", {
      fingerprint: {
        updatedAt: "2024-01-01T00:00:02.000Z",
        messageCount: 2,
        lastEventSeq: 4,
      },
      snapshot: {
        sessionId: "thread-session",
        title: "Cached Thread",
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
        lastMessagePreview: "Hello from cache",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:02.000Z",
        messageCount: 2,
        lastEventSeq: 4,
        feed: [],
        agents: [],
        todos: [],
        sessionUsage: null,
        lastTurnUsage: null,
        hasPendingAsk: false,
        hasPendingApproval: false,
      },
    });
    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().deleteThreadHistory(threadId);

    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
    expect(
      controlSocket.sent.some(
        (msg) =>
          msg?.type === "delete_session"
          && msg?.sessionId === "control-session"
          && msg?.targetSessionId === "thread-session"
      )
    ).toBe(true);
    expect(RUNTIME.sessionSnapshots.has("thread-session")).toBe(false);
    const cachedState = localStorageMock.getItem(DESKTOP_STATE_CACHE_KEY);
    expect(cachedState).not.toBeNull();
    expect(JSON.parse(cachedState!).sessionSnapshots?.["thread-session"]).toBeUndefined();
  });

  test("removeWorkspace sends session_close for control and thread sessions", async () => {
    await useAppStore.getState().newThread({ workspaceId, mode: "session" });
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) throw new Error("Expected selected thread");

    const controlSocket = socketByClient("desktop-control");
    const threadSocket = socketByClient("desktop");
    emitServerHello(controlSocket, "control-session");
    emitServerHello(threadSocket, "thread-session");
    controlSocket.sent = [];
    threadSocket.sent = [];

    await useAppStore.getState().removeWorkspace(workspaceId);

    expect(
      controlSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "control-session")
    ).toBe(true);
    expect(
      threadSocket.sent.some((msg) => msg?.type === "session_close" && msg?.sessionId === "thread-session")
    ).toBe(true);
  });
});
