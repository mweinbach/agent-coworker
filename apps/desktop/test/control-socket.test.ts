import { beforeEach, describe, expect, mock, test } from "bun:test";

type MockSocketOpts = {
  url: string;
  client: string;
  autoReconnect?: boolean;
  resumeSessionId?: string;
  onEvent?: (evt: any) => void;
  onClose?: (reason: string) => void;
};

const MOCK_SOCKETS: MockAgentSocket[] = [];

class MockAgentSocket {
  public sent: any[] = [];
  public url: string;

  constructor(public readonly opts: MockSocketOpts) {
    this.url = opts.url;
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

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: MockAgentSocket,
}));

const { createControlSocketHelpers } = await import("../src/app/store.helpers/controlSocket");
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");

let persistCalls = 0;

const deps = {
  nowIso: () => "2026-03-20T00:00:00.000Z",
  makeId: () => "note-1",
  persist: () => {
    persistCalls += 1;
  },
  pushNotification: <T>(notifications: T[]) => notifications,
  isProviderName: () => true,
};

function socketByClient(client: string): MockAgentSocket {
  const socket = [...MOCK_SOCKETS].reverse().find((entry) => entry.opts.client === client);
  if (!socket) {
    throw new Error(`Missing mock socket for client=${client}`);
  }
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
    },
  });
}

function makeThread(threadId: string, workspaceId: string) {
  return {
    id: threadId,
    workspaceId,
    title: threadId,
    titleSource: "manual" as const,
    createdAt: "2026-03-20T00:00:00.000Z",
    lastMessageAt: "2026-03-20T00:00:00.000Z",
    status: "active" as const,
    sessionId: threadId,
    messageCount: 1,
    lastEventSeq: 1,
    draft: false,
    legacyTranscriptId: null,
  };
}

function makeSessionSummary(sessionId: string) {
  return {
    sessionId,
    title: sessionId,
    titleSource: "manual",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
    messageCount: 1,
    lastEventSeq: 1,
  };
}

describe("control socket helper timeouts", () => {
  const workspaceId = "ws-timeouts";
  const state = {
    workspaceRuntimeById: {
      [workspaceId]: {
        serverUrl: "ws://mock",
        error: null,
        controlSessionId: "control-session",
      },
    },
  };
  const get = () => state as any;
  const set = (() => {}) as any;

  beforeEach(() => {
    MOCK_SOCKETS.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.sessionSnapshots.clear();
    persistCalls = 0;
  });

  test("requestWorkspaceSessions unregisters timed-out waiters", async () => {
    const helpers = createControlSocketHelpers(deps, { requestTimeoutMs: 25 });
    RUNTIME.controlSockets.set(workspaceId, {
      send: () => true,
    } as any);

    const requestPromise = helpers.requestWorkspaceSessions(get, set, workspaceId);
    await Promise.resolve();

    expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(1);
    await expect(requestPromise).resolves.toBeNull();
    expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(0);
  });

  test("requestSessionSnapshot unregisters timed-out waiters", async () => {
    const helpers = createControlSocketHelpers(deps, { requestTimeoutMs: 25 });
    RUNTIME.controlSockets.set(workspaceId, {
      send: () => true,
    } as any);

    const requestPromise = helpers.requestSessionSnapshot(get, set, workspaceId, "target-session");
    await Promise.resolve();

    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(1);
    await expect(requestPromise).resolves.toBeNull();
    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(0);
  });
});

describe("control socket workspace sessions", () => {
  const workspaceId = "ws-sessions";

  beforeEach(() => {
    MOCK_SOCKETS.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.sessionSnapshots.clear();
    persistCalls = 0;
  });

  test("sessions evict cached snapshots for removed workspace sessions", () => {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [
        makeThread("session-keep", workspaceId),
        makeThread("session-drop", workspaceId),
        makeThread("session-foreign", "ws-other"),
      ],
      selectedThreadId: null,
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          serverUrl: "ws://mock",
          error: null,
          controlSessionId: null,
          controlConfig: null,
          controlSessionConfig: null,
        },
      },
      workspaces: [],
      notifications: [],
      providerStatusRefreshing: false,
      providerLastAuthChallenge: null,
    } as any;
    const get = () => state;
    const set = (updater: any) => {
      const patch = typeof updater === "function" ? updater(state) : updater;
      Object.assign(state, patch);
    };

    RUNTIME.sessionSnapshots.set("session-keep", {
      fingerprint: { updatedAt: "2026-03-20T00:00:00.000Z", messageCount: 1, lastEventSeq: 1 },
      snapshot: { sessionId: "session-keep" },
    } as any);
    RUNTIME.sessionSnapshots.set("session-drop", {
      fingerprint: { updatedAt: "2026-03-20T00:00:00.000Z", messageCount: 1, lastEventSeq: 1 },
      snapshot: { sessionId: "session-drop" },
    } as any);
    RUNTIME.sessionSnapshots.set("session-foreign", {
      fingerprint: { updatedAt: "2026-03-20T00:00:00.000Z", messageCount: 1, lastEventSeq: 1 },
      snapshot: { sessionId: "session-foreign" },
    } as any);

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "sessions",
      sessionId: "control-session",
      sessions: [makeSessionSummary("session-keep")],
    });

    expect(RUNTIME.sessionSnapshots.has("session-keep")).toBe(true);
    expect(RUNTIME.sessionSnapshots.has("session-drop")).toBe(false);
    expect(RUNTIME.sessionSnapshots.has("session-foreign")).toBe(true);
    expect(persistCalls).toBe(1);
  });

  test("sessions pick a remaining workspace thread when the selected thread disappears", () => {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [
        makeThread("session-drop", workspaceId),
        makeThread("session-keep", workspaceId),
      ],
      selectedThreadId: "session-drop",
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          serverUrl: "ws://mock",
          error: null,
          controlSessionId: null,
          controlConfig: null,
          controlSessionConfig: null,
        },
      },
      workspaces: [],
      notifications: [],
      providerStatusRefreshing: false,
      providerLastAuthChallenge: null,
    } as any;
    const get = () => state;
    const set = (updater: any) => {
      const patch = typeof updater === "function" ? updater(state) : updater;
      Object.assign(state, patch);
    };

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "sessions",
      sessionId: "control-session",
      sessions: [makeSessionSummary("session-keep")],
    });

    expect(state.selectedThreadId).toBe("session-keep");
  });
});
