import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { clearJsonRpcSocketOverride, setJsonRpcSocketOverride } from "./helpers/jsonRpcSocketMock";

const jsonRpcRequests: Array<{ method: string; params?: unknown }> = [];
const jsonRpcHandlers = new Map<string, (params?: any) => any | Promise<any>>();

class MockJsonRpcSocket {
  static instances: MockJsonRpcSocket[] = [];
  readonly readyPromise = Promise.resolve();
  closed = false;

  constructor(public readonly opts: { url?: string; onOpen?: () => void; onClose?: () => void }) {
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
    this.opts.onClose?.();
  }
}

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: class {},
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { createControlSocketHelpers } = await import("../src/app/store.helpers/controlSocket");
const { ensureWorkspaceJsonRpcSocket } = await import("../src/app/store.helpers/jsonRpcSocket");
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

async function flushAsyncWork() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("control socket helpers over JSON-RPC", () => {
  beforeEach(() => {
    setJsonRpcSocketOverride(MockJsonRpcSocket);
    jsonRpcRequests.length = 0;
    jsonRpcHandlers.clear();
    MockJsonRpcSocket.instances.length = 0;
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
    RUNTIME.sessionSnapshots.clear();
    RUNTIME.providerStatusRefreshGeneration = 0;
    persistCalls = 0;
  });

  afterEach(() => {
    clearJsonRpcSocketOverride();
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

  test("requestJsonRpcControlEvent treats successful no-event responses as success", async () => {
    const workspaceId = "ws-no-event";
    const { get, set } = createState(workspaceId);
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/provider/catalog/read");
      return {};
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/provider/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
  });

  test("requestWorkspaceSessions uses the retryable socket path even if readyPromise rejected during reconnect", async () => {
    const workspaceId = "ws-retryable";
    const { get, set } = createState(workspaceId);
    let requestCalls = 0;
    const readyPromise = Promise.reject(new Error("initialize failed"));
    readyPromise.catch(() => {});
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise,
      request: async (method: string) => {
        requestCalls += 1;
        expect(method).toBe("thread/list");
        return {
          threads: [makeThreadListEntry("session-1")],
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    const helpers = createControlSocketHelpers(deps);
    const sessions = await helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);

    expect(requestCalls).toBe(1);
    expect(sessions?.map((session) => session.sessionId)).toEqual(["session-1"]);
  });

  test("ensureControlSocket backfills control session state if the first socket caller had no store setter", () => {
    const workspaceId = "ws-backfill";
    const { state, get, set } = createState(workspaceId);

    ensureWorkspaceJsonRpcSocket(get as any, undefined, workspaceId);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBeNull();

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe(`jsonrpc:${workspaceId}`);
  });

  test("ensureControlSocket recreates the shared workspace socket when serverUrl changes", () => {
    const workspaceId = "ws-url-change";
    const { state, get, set } = createState(workspaceId);
    const helpers = createControlSocketHelpers(deps);

    const firstSocket = helpers.ensureControlSocket(get as any, set as any, workspaceId);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect((firstSocket as MockJsonRpcSocket).opts.url).toBe("ws://mock");

    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://changed";
    const secondSocket = helpers.ensureControlSocket(get as any, set as any, workspaceId);

    expect(MockJsonRpcSocket.instances).toHaveLength(2);
    expect(firstSocket).not.toBe(secondSocket);
    expect((firstSocket as MockJsonRpcSocket).closed).toBe(true);
    expect((secondSocket as MockJsonRpcSocket).opts.url).toBe("ws://changed");
  });

  test("ensureControlSocket lifecycle callbacks use the latest get closure after reconnect", async () => {
    const workspaceId = "ws-lifecycle";
    const first = createState(workspaceId);
    first.state.workspaces[0].path = "/tmp/workspace-first";
    const helpers = createControlSocketHelpers(deps);

    helpers.ensureControlSocket(first.get as any, first.set as any, workspaceId);
    await flushAsyncWork();

    jsonRpcRequests.length = 0;

    const second = createState(workspaceId);
    second.state.workspaces[0].path = "/tmp/workspace-second";
    helpers.ensureControlSocket(second.get as any, second.set as any, workspaceId);

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();

    socket.close();
    jsonRpcRequests.length = 0;
    socket.connect();
    await flushAsyncWork();

    expect(jsonRpcRequests.find((entry) => entry.method === "thread/list")?.params).toEqual({
      cwd: "/tmp/workspace-second",
    });
    expect(jsonRpcRequests.find((entry) => entry.method === "cowork/provider/catalog/read")?.params).toEqual({
      cwd: "/tmp/workspace-second",
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

  test("provider auth refresh clears loading when the follow-up refresh only partially succeeds", async () => {
    const workspaceId = "ws-provider-auth";
    const { state, get, set } = createState(workspaceId);
    const calls: string[] = [];
    installFakeSocket(workspaceId, async (method) => {
      calls.push(method);
      if (method === "cowork/provider/auth/setApiKey") {
        return {
          event: {
            type: "provider_auth_result",
            sessionId: "jsonrpc-control",
            provider: "openai",
            methodId: "api_key",
            ok: true,
            mode: "api_key",
            message: "saved",
          },
        };
      }
      if (method === "cowork/provider/status/refresh") {
        return {};
      }
      if (method === "cowork/provider/catalog/read") {
        throw new Error("catalog refresh failed");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/provider/auth/setApiKey",
      {
        cwd: "/tmp/workspace",
        provider: "openai",
        methodId: "api_key",
        apiKey: "sk-test",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ok).toBe(true);
    expect(state.providerStatusRefreshing).toBe(false);
    expect(calls).toEqual([
      "cowork/provider/auth/setApiKey",
      "cowork/provider/status/refresh",
      "cowork/provider/catalog/read",
    ]);
  });

  test("stale provider auth refresh completion does not clear loading after a newer manual refresh finishes", async () => {
    const workspaceId = "ws-provider-auth-refresh-gen";
    const { state, get, set } = createState(workspaceId);
    let statusRefreshInvocation = 0;
    let releaseFirstRefresh: (() => void) | null = null;
    const firstRefreshBarrier = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });

    installFakeSocket(workspaceId, async (method) => {
      if (method === "cowork/provider/auth/setApiKey") {
        return {
          event: {
            type: "provider_auth_result",
            sessionId: "jsonrpc-control",
            provider: "openai",
            methodId: "api_key",
            ok: true,
            mode: "api_key",
            message: "saved",
          },
        };
      }
      if (method === "cowork/provider/status/refresh") {
        statusRefreshInvocation += 1;
        if (statusRefreshInvocation === 1) {
          await firstRefreshBarrier;
        }
        return {};
      }
      if (method === "cowork/provider/catalog/read" || method === "cowork/provider/authMethods/read") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const helpers = createControlSocketHelpers(deps);
    void helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/provider/auth/setApiKey",
      {
        cwd: "/tmp/workspace",
        provider: "openai",
        methodId: "api_key",
        apiKey: "sk-test",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.providerStatusRefreshing).toBe(true);

    const { refreshProviderStatusForWorkspace } = await import("../src/app/store.actions/provider");
    await refreshProviderStatusForWorkspace(
      {
        get: get as any,
        set: set as any,
        makeId: () => "note-2",
        nowIso: () => "2026-03-21T00:00:01.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) =>
          helpers.requestJsonRpcControlEvent(args[0], args[1], args[2], args[3], args[4])) as any,
      },
      workspaceId,
      "/tmp/workspace",
    );
    expect(state.providerStatusRefreshing).toBe(false);

    releaseFirstRefresh?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.providerStatusRefreshing).toBe(false);
  });

  test("older provider_status events do not clear loading while a newer manual refresh is in flight", async () => {
    const workspaceId = "ws-provider-status-race";
    const { state, get, set } = createState(workspaceId);
    let statusRefreshInvocation = 0;
    let releaseFirstRefresh: (() => void) | null = null;
    let releaseSecondRefresh: (() => void) | null = null;
    const firstRefreshBarrier = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const secondRefreshBarrier = new Promise<void>((resolve) => {
      releaseSecondRefresh = resolve;
    });

    installFakeSocket(workspaceId, async (method) => {
      if (method === "cowork/provider/auth/setApiKey") {
        return {
          event: {
            type: "provider_auth_result",
            sessionId: "jsonrpc-control",
            provider: "openai",
            methodId: "api_key",
            ok: true,
            mode: "api_key",
            message: "saved",
          },
        };
      }
      if (method === "cowork/provider/status/refresh") {
        statusRefreshInvocation += 1;
        if (statusRefreshInvocation === 1) {
          await firstRefreshBarrier;
          return {
            event: {
              type: "provider_status",
              sessionId: "jsonrpc-control",
              providers: [
                {
                  provider: "openai",
                  authorized: true,
                  verified: true,
                  mode: "api_key",
                  account: null,
                  message: "ready",
                  checkedAt: "2026-03-22T00:00:00.000Z",
                },
              ],
            },
          };
        }
        if (statusRefreshInvocation === 2) {
          await secondRefreshBarrier;
        }
        return {};
      }
      if (method === "cowork/provider/catalog/read" || method === "cowork/provider/authMethods/read") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const helpers = createControlSocketHelpers(deps);
    void helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/provider/auth/setApiKey",
      {
        cwd: "/tmp/workspace",
        provider: "openai",
        methodId: "api_key",
        apiKey: "sk-test",
      },
    );
    await flushAsyncWork();
    expect(state.providerStatusRefreshing).toBe(true);

    const { refreshProviderStatusForWorkspace } = await import("../src/app/store.actions/provider");
    const manualRefreshPromise = refreshProviderStatusForWorkspace(
      {
        get: get as any,
        set: set as any,
        makeId: () => "note-2",
        nowIso: () => "2026-03-21T00:00:01.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) =>
          helpers.requestJsonRpcControlEvent(args[0], args[1], args[2], args[3], args[4])) as any,
      },
      workspaceId,
      "/tmp/workspace",
    );
    await flushAsyncWork();
    expect(state.providerStatusRefreshing).toBe(true);

    releaseFirstRefresh?.();
    await flushAsyncWork();

    expect(state.providerStatusByName.openai).toMatchObject({
      provider: "openai",
      authorized: true,
      verified: true,
    });
    expect(state.providerStatusRefreshing).toBe(true);

    releaseSecondRefresh?.();
    await manualRefreshPromise;
    await flushAsyncWork();

    expect(state.providerStatusRefreshing).toBe(false);
  });

  test("bootstrap refresh completion does not clear loading after a newer manual refresh starts", async () => {
    const workspaceId = "ws-bootstrap-provider-refresh-gen";
    const { state, get, set } = createState(workspaceId);
    let statusRefreshInvocation = 0;
    let releaseBootstrapRefresh: (() => void) | null = null;
    let releaseManualRefresh: (() => void) | null = null;
    const bootstrapRefreshBarrier = new Promise<void>((resolve) => {
      releaseBootstrapRefresh = resolve;
    });
    const manualRefreshBarrier = new Promise<void>((resolve) => {
      releaseManualRefresh = resolve;
    });

    jsonRpcHandlers.set("thread/list", async () => ({ threads: [] }));
    jsonRpcHandlers.set("cowork/provider/catalog/read", async () => ({}));
    jsonRpcHandlers.set("cowork/provider/authMethods/read", async () => ({}));
    jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({}));
    jsonRpcHandlers.set("cowork/memory/list", async () => ({}));
    jsonRpcHandlers.set("cowork/skills/catalog/read", async () => ({}));
    jsonRpcHandlers.set("cowork/skills/list", async () => ({}));
    jsonRpcHandlers.set("cowork/provider/status/refresh", async () => {
      statusRefreshInvocation += 1;
      if (statusRefreshInvocation === 1) {
        await bootstrapRefreshBarrier;
      } else if (statusRefreshInvocation === 2) {
        await manualRefreshBarrier;
      }
      return {};
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();
    expect(state.providerStatusRefreshing).toBe(true);

    const { refreshProviderStatusForWorkspace } = await import("../src/app/store.actions/provider");
    const manualRefreshPromise = refreshProviderStatusForWorkspace(
      {
        get: get as any,
        set: set as any,
        makeId: () => "note-3",
        nowIso: () => "2026-03-21T00:00:02.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) =>
          helpers.requestJsonRpcControlEvent(args[0], args[1], args[2], args[3], args[4])) as any,
      },
      workspaceId,
      "/tmp/workspace",
    );
    await flushAsyncWork();
    expect(state.providerStatusRefreshing).toBe(true);

    releaseBootstrapRefresh?.();
    await flushAsyncWork();
    expect(state.providerStatusRefreshing).toBe(true);

    releaseManualRefresh?.();
    await manualRefreshPromise;
    await flushAsyncWork();

    expect(state.providerStatusRefreshing).toBe(false);
  });

  test("provider auth refresh clears loading when the follow-up refresh succeeds without event envelopes", async () => {
    const workspaceId = "ws-provider-auth-no-event";
    const { state, get, set } = createState(workspaceId);
    const calls: string[] = [];
    installFakeSocket(workspaceId, async (method) => {
      calls.push(method);
      if (method === "cowork/provider/auth/setApiKey") {
        return {
          event: {
            type: "provider_auth_result",
            sessionId: "jsonrpc-control",
            provider: "openai",
            methodId: "api_key",
            ok: true,
            mode: "api_key",
            message: "saved",
          },
        };
      }
      if (method === "cowork/provider/status/refresh" || method === "cowork/provider/catalog/read") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/provider/auth/setApiKey",
      {
        cwd: "/tmp/workspace",
        provider: "openai",
        methodId: "api_key",
        apiKey: "sk-test",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ok).toBe(true);
    expect(state.providerStatusRefreshing).toBe(false);
    expect(calls).toEqual([
      "cowork/provider/auth/setApiKey",
      "cowork/provider/status/refresh",
      "cowork/provider/catalog/read",
    ]);
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
