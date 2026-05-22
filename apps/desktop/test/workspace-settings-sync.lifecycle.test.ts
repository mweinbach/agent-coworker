import { describe, expect, test } from "bun:test";
import {
  __controlSocketInternal,
  __threadEventReducerInternal,
  clearJsonRpcSocketOverride,
  createDeferred,
  disposeWorkspaceJsonRpcState,
  ensureControlSocket,
  ensureServerRunning,
  ensureThreadSocket,
  flushAsyncWork,
  getWorkspaceJsonRpcHelperState,
  jsonRpcActivityLog,
  jsonRpcRequests,
  jsonRpcResponseOverrides,
  jsonRpcSocketInternal,
  latestRequest,
  MockJsonRpcSocket,
  makeSessionSnapshot,
  primeWorkspaceConnection,
  RUNTIME,
  registerWorkspaceSettingsSyncLifecycleHooks,
  requestJsonRpcControlEvent,
  requestsFor,
  seedConnectedThread,
  setControlSessionConfigResponse,
  setJsonRpcSocketOverride,
  setMockedLoadedState,
  syncMockedWorkspaceSessions,
  transcriptBatches,
  useAppStore,
  workspaceId,
} from "./workspace-settings-sync.harness";

describe("workspace settings sync", () => {
  registerWorkspaceSettingsSyncLifecycleHooks();

  test("removeWorkspace reuses the shared JsonRpcSocket for thread/unsubscribe before closing it", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    const { threadId: helperThreadId } = seedConnectedThread();
    syncMockedWorkspaceSessions();
    const blockedProviderStatus = createDeferred<unknown>();
    jsonRpcResponseOverrides.set(
      "cowork/provider/status/refresh",
      async () => await blockedProviderStatus.promise,
    );
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      helperThreadId,
      "ws://mock",
    );
    await flushAsyncWork();

    const helperStateBefore = getWorkspaceJsonRpcHelperState(workspaceId);
    expect(helperStateBefore.socket).toMatchObject({
      isDisposed: false,
      hasStoreSetter: true,
    });
    expect(helperStateBefore.socket.routerCount).toBeGreaterThan(0);
    expect(helperStateBefore.socket.lifecycleListenerCount).toBeGreaterThan(0);
    expect(helperStateBefore.control).toEqual({
      isDisposed: false,
      hasRouterCleanup: true,
      hasLifecycleCleanup: true,
      hasBootstrapPromise: true,
      hasStoreGetter: true,
      hasStoreSetter: true,
    });
    expect(helperStateBefore.thread).toEqual({
      isDisposed: false,
      hasRouterCleanup: true,
      hasLifecycleCleanup: true,
      reconnectThreadIds: [helperThreadId],
    });

    jsonRpcRequests.length = 0;
    const socketsBefore = MockJsonRpcSocket.instances.length;
    expect(socketsBefore).toBeGreaterThan(0);

    await useAppStore.getState().removeWorkspace(workspaceId);
    blockedProviderStatus.resolve({
      event: {
        type: "provider_status",
        sessionId: "jsonrpc-control",
        providers: [],
      },
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(MockJsonRpcSocket.instances.length).toBe(socketsBefore);
    expect(requestsFor("thread/unsubscribe")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "thread/unsubscribe",
          params: { threadId: sessionId },
        }),
      ]),
    );
    const unsubscribeIndexes = jsonRpcActivityLog
      .map((entry, index) => (entry === "request:thread/unsubscribe" ? index : -1))
      .filter((index) => index >= 0);
    expect(unsubscribeIndexes.length).toBeGreaterThan(0);
    const closeIndex = jsonRpcActivityLog.indexOf("close");
    expect(closeIndex).toBeGreaterThan(Math.max(...unsubscribeIndexes));
    const helperStateAfter = getWorkspaceJsonRpcHelperState(workspaceId);
    expect(helperStateAfter.socket).toEqual({
      isDisposed: true,
      hasStoreSetter: false,
      routerCount: 0,
      lifecycleListenerCount: 0,
    });
    expect(helperStateAfter.control).toEqual({
      isDisposed: true,
      hasRouterCleanup: false,
      hasLifecycleCleanup: false,
      hasBootstrapPromise: false,
      hasStoreGetter: false,
      hasStoreSetter: false,
    });
    expect(helperStateAfter.thread).toEqual({
      isDisposed: true,
      hasRouterCleanup: false,
      hasLifecycleCleanup: false,
      reconnectThreadIds: [],
    });
    expect(useAppStore.getState().workspaces.some((w) => w.id === workspaceId)).toBe(false);
    expect(useAppStore.getState().threads.some((t) => t.id === threadId)).toBe(false);
  });

  test("removeWorkspace closes the shared JsonRpcSocket before removing it so install waiters reject", async () => {
    primeWorkspaceConnection();
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);

    const rejected = createDeferred<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:project",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    await Promise.all([
      useAppStore.getState().removeWorkspace(workspaceId),
      expect(rejected.promise).rejects.toThrow("Control connection closed"),
    ]);

    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
  });

  test("removeWorkspace clears pluginManagementWorkspaceId when the deleted workspace owned plugin management", async () => {
    primeWorkspaceConnection();
    const managementWorkspaceId = `ws-management-${crypto.randomUUID()}`;
    useAppStore.setState((state) => ({
      ...state,
      workspaces: [
        ...state.workspaces,
        {
          id: managementWorkspaceId,
          name: "Management Workspace",
          path: "/tmp/workspace-management",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultPreferredChildModel: "gpt-5.2",
          defaultToolOutputOverflowChars: 25000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          wsProtocol: "jsonrpc",
          yolo: false,
        },
      ],
      pluginManagementWorkspaceId: managementWorkspaceId,
    }));

    await useAppStore.getState().removeWorkspace(managementWorkspaceId);

    const state = useAppStore.getState();
    expect(state.pluginManagementWorkspaceId).toBeNull();
    expect(state.workspaces.some((workspace) => workspace.id === managementWorkspaceId)).toBe(
      false,
    );
  });

  test("ensureServerRunning reactivates disposed JSON-RPC helper state for an existing workspace", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    syncMockedWorkspaceSessions();
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    await flushAsyncWork();

    disposeWorkspaceJsonRpcState(useAppStore.getState as any, workspaceId);
    expect(getWorkspaceJsonRpcHelperState(workspaceId)).toEqual({
      socket: {
        isDisposed: true,
        hasStoreSetter: false,
        routerCount: 0,
        lifecycleListenerCount: 0,
      },
      control: {
        isDisposed: true,
        hasRouterCleanup: false,
        hasLifecycleCleanup: false,
        hasBootstrapPromise: false,
        hasStoreGetter: false,
        hasStoreSetter: false,
      },
      thread: {
        isDisposed: true,
        hasRouterCleanup: false,
        hasLifecycleCleanup: false,
        reconnectThreadIds: [],
      },
    });

    await ensureServerRunning(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
    );
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    await flushAsyncWork();

    const helperStateAfter = getWorkspaceJsonRpcHelperState(workspaceId);
    expect(helperStateAfter.socket.isDisposed).toBe(false);
    expect(helperStateAfter.socket.hasStoreSetter).toBe(true);
    expect(helperStateAfter.socket.routerCount).toBeGreaterThan(0);
    expect(helperStateAfter.socket.lifecycleListenerCount).toBeGreaterThan(0);
    expect(helperStateAfter.control).toMatchObject({
      isDisposed: false,
      hasRouterCleanup: true,
      hasLifecycleCleanup: true,
      hasStoreGetter: true,
      hasStoreSetter: true,
    });
    expect(helperStateAfter.thread).toEqual({
      isDisposed: false,
      hasRouterCleanup: true,
      hasLifecycleCleanup: true,
      reconnectThreadIds: [threadId],
    });
  });

  test("restartWorkspaceServer preserves JSON-RPC workspace state so control bootstrap and thread reconnect recover", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    syncMockedWorkspaceSessions();
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    jsonRpcRequests.length = 0;

    await useAppStore.getState().restartWorkspaceServer(workspaceId);
    await flushAsyncWork();
    await flushAsyncWork();

    const helperStateAfter = getWorkspaceJsonRpcHelperState(workspaceId);
    expect(helperStateAfter.socket.isDisposed).toBe(false);
    expect(helperStateAfter.socket.hasStoreSetter).toBe(true);
    expect(helperStateAfter.socket.routerCount).toBeGreaterThan(0);
    expect(helperStateAfter.socket.lifecycleListenerCount).toBeGreaterThan(0);
    expect(helperStateAfter.control).toMatchObject({
      isDisposed: false,
      hasLifecycleCleanup: true,
      hasStoreGetter: true,
      hasStoreSetter: true,
    });
    expect(helperStateAfter.thread).toEqual({
      isDisposed: false,
      hasRouterCleanup: true,
      hasLifecycleCleanup: true,
      reconnectThreadIds: [],
    });
    expect(requestsFor("thread/list").length).toBeGreaterThan(0);
    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.controlSessionId).toBe(
      "jsonrpc-control",
    );
    jsonRpcRequests.length = 0;
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    await flushAsyncWork();
    expect(requestsFor("thread/resume").length).toBeGreaterThan(0);
    expect(getWorkspaceJsonRpcHelperState(workspaceId).thread.reconnectThreadIds).toEqual([
      threadId,
    ]);
    expect(useAppStore.getState().threads.find((thread) => thread.id === threadId)?.status).toBe(
      "active",
    );
  });

  test("restartWorkspaceServer clears stale disposed JSON-RPC helper state before reconnecting", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    syncMockedWorkspaceSessions();
    ensureControlSocket(useAppStore.getState as any, useAppStore.setState as any, workspaceId);
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    await flushAsyncWork();

    disposeWorkspaceJsonRpcState(useAppStore.getState as any, workspaceId);
    jsonRpcRequests.length = 0;

    await useAppStore.getState().restartWorkspaceServer(workspaceId);
    await flushAsyncWork();
    await flushAsyncWork();

    const helperStateAfter = getWorkspaceJsonRpcHelperState(workspaceId);
    expect(helperStateAfter.socket.isDisposed).toBe(false);
    expect(helperStateAfter.control.isDisposed).toBe(false);
    expect(helperStateAfter.thread).toMatchObject({
      isDisposed: false,
      reconnectThreadIds: [],
    });
    expect(requestsFor("thread/list").length).toBeGreaterThan(0);
    expect(useAppStore.getState().workspaceRuntimeById[workspaceId]?.controlSessionId).toBe(
      "jsonrpc-control",
    );

    jsonRpcRequests.length = 0;
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    await flushAsyncWork();

    expect(requestsFor("thread/resume").length).toBeGreaterThan(0);
    expect(getWorkspaceJsonRpcHelperState(workspaceId).thread).toEqual({
      isDisposed: false,
      hasRouterCleanup: true,
      hasLifecycleCleanup: true,
      reconnectThreadIds: [threadId],
    });
  });
});
