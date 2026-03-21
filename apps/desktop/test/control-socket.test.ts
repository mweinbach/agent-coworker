import { beforeEach, describe, expect, mock, test } from "bun:test";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: any) => any | Promise<any>>();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();

  constructor(public readonly opts: { onOpen?: () => void; onClose?: () => void }) {
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
    this.opts.onClose?.();
  }
}

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {},
  JsonRpcSocket: MockJsonRpcSocket,
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
  pushNotification: <T>(notifications: T[], entry: T) => [...notifications, entry],
  isProviderName: () => true,
};

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

function makeThreadListEntry(threadId: string) {
  return {
    id: threadId,
    title: threadId,
    modelProvider: "openai",
    model: "gpt-5.2",
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
  };
}

function createState(workspaceId: string, patch: Record<string, unknown> = {}) {
  const state = {
    selectedWorkspaceId: workspaceId,
    selectedThreadId: null,
    threads: [],
    threadRuntimeById: {},
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock",
        ...((patch.workspaceRuntimeById as Record<string, unknown> | undefined)?.[workspaceId] ?? {}),
      },
    },
    workspaces: [
      {
        id: workspaceId,
        name: "Workspace",
        path: "/tmp/workspace",
        createdAt: "2026-03-20T00:00:00.000Z",
        lastOpenedAt: "2026-03-20T00:00:00.000Z",
        wsProtocol: "jsonrpc",
        defaultEnableMcp: true,
        defaultBackupsEnabled: true,
        yolo: false,
      },
    ],
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
    ...patch,
  } as any;
  const get = () => state;
  const set = (updater: any) => {
    const patchValue = typeof updater === "function" ? updater(state) : updater;
    Object.assign(state, patchValue);
  };
  return { state, get, set };
}

function installFakeSocket(workspaceId: string, request: (method: string, params?: any) => any | Promise<any>) {
  RUNTIME.jsonRpcSockets.set(workspaceId, {
    readyPromise: Promise.resolve(),
    request,
    respond: () => true,
    close: () => {},
  } as any);
}

describe("control socket helpers over JSON-RPC", () => {
  beforeEach(() => {
    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    persistCalls = 0;
  });

  test("requestWorkspaceSessions evicts removed cached snapshots and reconciles selection", async () => {
    const workspaceId = "ws-sessions";
    const { state, get, set } = createState(workspaceId, {
      threads: [
        makeThread("session-drop", workspaceId),
        makeThread("session-keep", workspaceId),
        makeThread("session-foreign", "ws-other"),
      ],
      selectedThreadId: "session-drop",
    });

    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("thread/list");
      return {
        threads: [makeThreadListEntry("session-keep")],
      };
    });

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
    const sessions = await helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);

    expect(sessions?.map((session) => session.sessionId)).toEqual(["session-keep"]);
    expect(state.selectedThreadId).toBe("session-keep");
    expect(RUNTIME.sessionSnapshots.has("session-keep")).toBe(true);
    expect(RUNTIME.sessionSnapshots.has("session-drop")).toBe(false);
    expect(RUNTIME.sessionSnapshots.has("session-foreign")).toBe(true);
    expect(persistCalls).toBe(1);
  });

  test("requestSessionSnapshot reads coworkSnapshot from thread/read", async () => {
    const workspaceId = "ws-snapshot";
    const { get, set } = createState(workspaceId);
    installFakeSocket(workspaceId, async (method, params) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ threadId: "session-1", includeTurns: true });
      return {
        coworkSnapshot: {
          sessionId: "session-1",
          title: "Snapshot title",
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const snapshot = await helpers.requestSessionSnapshot(get as any, set as any, workspaceId, "session-1");
    expect(snapshot).toEqual({
      sessionId: "session-1",
      title: "Snapshot title",
    });
  });

  test("requestJsonRpcControlEvent resolves matching skill install waiters", async () => {
    const workspaceId = "ws-skills";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillMutationPendingKeys: {
            preview: true,
            "install:project": true,
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/skills/catalog/read");
      return {
        event: {
          type: "skills_catalog",
          sessionId: "jsonrpc-control",
          catalog: { installations: [], sources: [], stats: { totalInstallations: 0, enabledInstallations: 0 } },
          mutationBlocked: false,
          clearedMutationPendingKeys: ["install:project"],
        },
      };
    });

    const resolved = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:project",
      resolve: resolved.resolve,
      reject: resolved.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(get as any, set as any, workspaceId, "cowork/skills/catalog/read", {
      cwd: "/tmp/workspace",
    });

    await resolved.promise;
    expect(ok).toBe(true);
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ preview: true });
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
  });

  test("requestJsonRpcControlEvent applies error events and rejects pending install waiters", async () => {
    const workspaceId = "ws-error";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogLoading: true,
          skillMutationPendingKeys: { "install:global": true },
        },
      },
    });
    installFakeSocket(workspaceId, async () => ({
      event: {
        type: "error",
        sessionId: "jsonrpc-control",
        source: "session",
        code: "internal_error",
        message: "install failed on disk",
      },
    }));

    const rejected = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:global",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    await expect(
      Promise.all([
        helpers.requestJsonRpcControlEvent(get as any, set as any, workspaceId, "cowork/skills/install", {
          cwd: "/tmp/workspace",
          sourceInput: "foo",
          targetScope: "global",
        }),
        rejected.promise,
      ]),
    ).rejects.toThrow("install failed on disk");

    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe("install failed on disk");
    expect(state.notifications).toHaveLength(1);
  });

  test("closing the shared workspace socket clears pending control runtime", async () => {
    const workspaceId = "ws-close";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          memoriesLoading: true,
          skillCatalogLoading: true,
          skillMutationPendingKeys: { preview: true },
        },
      },
      view: "skills",
    });

    const rejected = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "preview",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();
    socket.close();

    await expect(rejected.promise).rejects.toThrow("Control connection closed");
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].controlSessionConfig).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].memoriesLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
    expect(state.notifications).toHaveLength(1);
  });
});
