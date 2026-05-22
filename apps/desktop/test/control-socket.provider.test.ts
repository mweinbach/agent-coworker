import { describe, expect, test } from "bun:test";
import {
  MockJsonRpcSocket,
  RUNTIME,
  clearJsonRpcSocketOverride,
  createControlSocketHelpers,
  createState,
  defaultWorkspaceRuntime,
  deps,
  ensureWorkspaceJsonRpcSocket,
  flushAsyncWork,
  installFakeSocket,
  jsonRpcHandlers,
  jsonRpcRequests,
  makeThread,
  makeThreadListEntry,
  persistCalls,
  registerControlSocketLifecycleHooks,
  setJsonRpcSocketOverride,
} from "./control-socket.harness";

describe("control socket helpers over JSON-RPC", () => {
  registerControlSocketLifecycleHooks();

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
      if (
        method === "cowork/provider/catalog/read" ||
        method === "cowork/provider/authMethods/read"
      ) {
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
    await refreshProviderStatusForWorkspace(get as any, set as any, workspaceId, "/tmp/workspace", {
      makeId: () => "note-2",
      nowIso: () => "2026-03-21T00:00:01.000Z",
      pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
      requestJsonRpcControlEvent: ((...args: any[]) =>
        helpers.requestJsonRpcControlEvent(args[0], args[1], args[2], args[3], args[4])) as any,
    });
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
      if (
        method === "cowork/provider/catalog/read" ||
        method === "cowork/provider/authMethods/read"
      ) {
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
      get as any,
      set as any,
      workspaceId,
      "/tmp/workspace",
      {
        makeId: () => "note-2",
        nowIso: () => "2026-03-21T00:00:01.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) =>
          helpers.requestJsonRpcControlEvent(args[0], args[1], args[2], args[3], args[4])) as any,
      },
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
      get as any,
      set as any,
      workspaceId,
      "/tmp/workspace",
      {
        makeId: () => "note-3",
        nowIso: () => "2026-03-21T00:00:02.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) =>
          helpers.requestJsonRpcControlEvent(args[0], args[1], args[2], args[3], args[4])) as any,
      },
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
      if (
        method === "cowork/provider/status/refresh" ||
        method === "cowork/provider/catalog/read"
      ) {
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
