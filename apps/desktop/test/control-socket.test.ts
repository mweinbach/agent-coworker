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
const { RUNTIME, defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");

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
    RUNTIME.skillInstallWaiters.clear();
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
    RUNTIME.skillInstallWaiters.clear();
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

describe("control socket skill error recovery", () => {
  const workspaceId = "ws-skills";

  beforeEach(() => {
    MOCK_SOCKETS.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    persistCalls = 0;
  });

  test("error clears pending skill state without clearing the server skill-mutation block", () => {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [],
      selectedThreadId: null,
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogLoading: true,
          skillMutationPendingKeys: { preview: true },
          skillsMutationBlocked: true,
          skillsMutationBlockedReason: "catalog locked",
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
      type: "error",
      sessionId: "control-session",
      source: "session",
      code: "internal_error",
      message: "EACCES: permission denied",
    });

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogError).toBe("EACCES: permission denied");
    expect(state.workspaceRuntimeById[workspaceId].skillsMutationBlocked).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].skillsMutationBlockedReason).toBe("catalog locked");
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe("EACCES: permission denied");
  });

  test("error leaves skill state alone when no skill work is pending", () => {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [],
      selectedThreadId: null,
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogError: "keep catalog error",
          skillMutationError: "keep mutation error",
          skillsMutationBlocked: true,
          skillsMutationBlockedReason: "still blocked",
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
      type: "error",
      sessionId: "control-session",
      source: "session",
      code: "internal_error",
      message: "provider skill handshake failed",
    });

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogError).toBe("keep catalog error");
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe("keep mutation error");
    expect(state.workspaceRuntimeById[workspaceId].skillsMutationBlocked).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].skillsMutationBlockedReason).toBe("still blocked");
  });

  test("error rejects skill install waiter when pending key matches", async () => {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [],
      selectedThreadId: null,
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillMutationPendingKeys: { "install:global": true },
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

    const installPromise = new Promise<void>((resolve, reject) => {
      RUNTIME.skillInstallWaiters.set(workspaceId, {
        pendingKey: "install:global",
        resolve,
        reject,
      });
    });

    controlSocket.emit({
      type: "error",
      sessionId: "control-session",
      source: "session",
      code: "internal_error",
      message: "install failed on disk",
    });

    await expect(installPromise).rejects.toThrow("install failed on disk");
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
  });
});

describe("control socket skill catalog loading", () => {
  const workspaceId = "ws-skill-loading";

  beforeEach(() => {
    MOCK_SOCKETS.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    persistCalls = 0;
  });

  test("server_hello restores the loading state for an open skills view", () => {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [],
      selectedThreadId: null,
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogError: "stale error",
        },
      },
      workspaces: [],
      notifications: [],
      providerStatusRefreshing: false,
      providerLastAuthChallenge: null,
      view: "skills",
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

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogError).toBeNull();
    expect(controlSocket.sent).toContainEqual({
      type: "skills_catalog_get",
      sessionId: "control-session",
    });
  });
});

describe("control socket skill detail events", () => {
  const workspaceId = "ws-skill-events";

  function createState(runtimePatch: Record<string, unknown> = {}) {
    const state = {
      selectedWorkspaceId: workspaceId,
      threads: [],
      selectedThreadId: null,
      threadRuntimeById: {},
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          ...runtimePatch,
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
    return { state, get, set };
  }

  beforeEach(() => {
    MOCK_SOCKETS.length = 0;
    RUNTIME.controlSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    persistCalls = 0;
  });

  test("skills_catalog resolves skill install waiter when pending key matches", async () => {
    const { state, get, set } = createState({
      skillMutationPendingKeys: {
        preview: true,
        "install:project": true,
      },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    const installPromise = new Promise<void>((resolve, reject) => {
      RUNTIME.skillInstallWaiters.set(workspaceId, {
        pendingKey: "install:project",
        resolve,
        reject,
      });
    });

    controlSocket.emit({
      type: "skills_catalog",
      sessionId: "control-session",
      catalog: { scopes: [], effectiveSkills: [], installations: [] },
      mutationBlocked: false,
      clearedMutationPendingKeys: ["install:project"],
    } as any);

    await installPromise;
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ preview: true });
  });

  test("skills_catalog from plain refresh keeps unrelated pending keys and install waiter", async () => {
    const { state, get, set } = createState({
      skillCatalogLoading: true,
      skillMutationPendingKeys: {
        preview: true,
        "install:project": true,
      },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");

    let installResolved = false;
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:project",
      resolve: () => {
        installResolved = true;
      },
      reject: () => {
        throw new Error("install waiter should not reject");
      },
    });

    controlSocket.emit({
      type: "skills_catalog",
      sessionId: "control-session",
      catalog: { scopes: [], effectiveSkills: [], installations: [] },
      mutationBlocked: false,
    } as any);

    await Promise.resolve();
    expect(installResolved).toBe(false);
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      preview: true,
      "install:project": true,
    });
  });

  test("skill_installation keeps in-flight mutation keys while loading details", () => {
    const { state, get, set } = createState({
      selectedSkillInstallationId: "install-1",
      skillMutationPendingKeys: { "install:project": true },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "skill_installation",
      sessionId: "control-session",
      installation: { installationId: "install-1" },
      content: "Skill docs",
    } as any);

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ "install:project": true });
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallation?.installationId).toBe("install-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBe("Skill docs");
  });

  test("skill_install_preview only clears the preview pending key", () => {
    const { state, get, set } = createState({
      skillMutationPendingKeys: {
        preview: true,
        "install:project": true,
      },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "skill_install_preview",
      sessionId: "control-session",
      preview: { summary: "preview" },
    } as any);

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ "install:project": true });
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillPreview).toEqual({ summary: "preview" });
  });

  test("skill_install_preview from install/update does not clear preview pending or clobber in-flight preview", () => {
    const { state, get, set } = createState({
      skillMutationPendingKeys: {
        preview: true,
        "install:project": true,
      },
      selectedSkillPreview: { summary: "waiting-for-user-preview" },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "skill_install_preview",
      sessionId: "control-session",
      fromUserPreviewRequest: false,
      preview: { summary: "side-effect-from-install" },
    } as any);

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      preview: true,
      "install:project": true,
    });
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillPreview).toEqual({
      summary: "waiting-for-user-preview",
    });
  });

  test("skill_installation_update_check keeps in-flight mutation keys", () => {
    const { state, get, set } = createState({
      skillMutationPendingKeys: { "install:project": true },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const controlSocket = socketByClient("desktop-control");
    emitServerHello(controlSocket, "control-session");
    controlSocket.emit({
      type: "skill_installation_update_check",
      sessionId: "control-session",
      result: { installationId: "install-1", canUpdate: true },
    } as any);

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ "install:project": true });
    expect(state.workspaceRuntimeById[workspaceId].skillUpdateChecksByInstallationId["install-1"]).toEqual({
      installationId: "install-1",
      canUpdate: true,
    });
  });
});
