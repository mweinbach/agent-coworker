import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../src/lib/wsProtocol";
import {
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
  jsonRpcResponses,
  MockJsonRpcSocket,
  makeThread,
  makeThreadListEntry,
  persistCalls,
  RUNTIME,
  registerControlSocketLifecycleHooks,
  respondToJsonRpcRequest,
  setJsonRpcSocketOverride,
} from "./control-socket.harness";

const { bumpAgentProfilesCatalogGeneration } = await import(
  "../src/app/store.helpers/runtimeState"
);

type AgentProfilesCatalogEvent = Extract<SessionEvent, { type: "agent_profiles_catalog" }>;

function agentProfilesCatalogEvent(displayName: string): AgentProfilesCatalogEvent {
  const profile = {
    version: 1,
    scope: "workspace" as const,
    id: "qa-reviewer",
    displayName,
    description: "",
    enabled: true,
    baseRole: "reviewer" as const,
    prompt: "Review regressions carefully.",
    allowedBuiltInTools: ["read"],
    allowedMcpServers: [],
    skillNames: [],
  };
  const entry: AgentProfilesCatalogEvent["catalog"]["profiles"][number] = {
    scope: "workspace",
    path: `/profiles/${profile.id}.json`,
    effective: true,
    shadowed: false,
    profile,
  };
  return {
    type: "agent_profiles_catalog",
    catalog: {
      profiles: [entry],
      effectiveProfiles: [entry],
      diagnostics: [],
      roots: {
        globalDir: "/tmp/global-profiles",
        workspaceDir: "/tmp/workspace-profiles",
      },
    },
  };
}

describe("control socket helpers over JSON-RPC", () => {
  registerControlSocketLifecycleHooks();

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

  test("ensureControlSocket uses desktop socket startup budgets", () => {
    const workspaceId = "ws-timeout-budget";
    const { get, set } = createState(workspaceId);
    const helpers = createControlSocketHelpers(deps);

    const socket = helpers.ensureControlSocket(get as any, set as any, workspaceId);

    expect(socket).toBeInstanceOf(MockJsonRpcSocket);
    expect((socket as MockJsonRpcSocket).opts.openTimeoutMs).toBe(5_000);
    expect((socket as MockJsonRpcSocket).opts.handshakeTimeoutMs).toBe(10_000);
  });

  test("stale socket close after a serverUrl swap does not clear the active control session", async () => {
    const workspaceId = "ws-stale-close";
    const { state, get, set } = createState(workspaceId);
    const helpers = createControlSocketHelpers(deps);

    const firstSocket = helpers.ensureControlSocket(
      get as any,
      set as any,
      workspaceId,
    ) as MockJsonRpcSocket;
    await flushAsyncWork();
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe(`jsonrpc:${workspaceId}`);

    MockJsonRpcSocket.deferClose = true;
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://changed";
    const secondSocket = helpers.ensureControlSocket(
      get as any,
      set as any,
      workspaceId,
    ) as MockJsonRpcSocket;
    await flushAsyncWork();

    expect(secondSocket).not.toBe(firstSocket);
    expect(firstSocket.closed).toBe(true);
    expect(RUNTIME.jsonRpcSockets.get(workspaceId)).toBe(secondSocket);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe(`jsonrpc:${workspaceId}`);

    firstSocket.emitDeferredClose();
    await flushAsyncWork();

    expect(RUNTIME.jsonRpcSockets.get(workspaceId)).toBe(secondSocket);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe(`jsonrpc:${workspaceId}`);
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
    expect(
      jsonRpcRequests.find((entry) => entry.method === "cowork/provider/catalog/read")?.params,
    ).toEqual({
      cwd: "/tmp/workspace-second",
    });
  });

  test("reconnecting lifecycle keeps transient control state before reopen", async () => {
    const workspaceId = "ws-reconnecting";
    const { state, get, set } = createState(workspaceId);
    const helpers = createControlSocketHelpers(deps);
    const skillInstall = Promise.withResolvers<void>();
    const pluginInstall = Promise.withResolvers<void>();

    const socket = helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();
    Object.assign(state.workspaceRuntimeById[workspaceId], {
      controlConfig: {
        provider: "openai",
        model: "gpt-5.2",
        workingDirectory: "/tmp/workspace",
      },
      memoriesLoading: true,
      skillMutationPendingKeys: { "skill:install": true },
      pluginMutationPendingKeys: { "plugin:install": true },
    });
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "skill:install",
      resolve: skillInstall.resolve,
      reject: skillInstall.reject,
    });
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install",
      resolve: pluginInstall.resolve,
      reject: pluginInstall.reject,
    });

    (socket as MockJsonRpcSocket).reconnecting();
    await flushAsyncWork();

    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].controlConfig).toEqual({
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
    });
    expect(state.workspaceRuntimeById[workspaceId].memoriesLoading).toBe(true);
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(true);
    expect(RUNTIME.pluginInstallWaiters.has(workspaceId)).toBe(true);
    expect(state.notifications).toEqual([]);

    const connectCalls = (socket as MockJsonRpcSocket).connectCalls;
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    expect((socket as MockJsonRpcSocket).connectCalls).toBe(connectCalls);
  });

  test("requestJsonRpc retries only classified methods", async () => {
    const workspaceId = "ws-retry-classification";
    const { get, set } = createState(workspaceId);
    const helpers = createControlSocketHelpers(deps);

    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await helpers.requestJsonRpcControl(
      get as any,
      set as any,
      workspaceId,
      "cowork/session/state/read",
      { cwd: "/tmp/workspace" },
    );
    await helpers.requestJsonRpcControl(get as any, set as any, workspaceId, "research/get", {
      researchId: "research-1",
    });
    await helpers.requestJsonRpcControl(get as any, set as any, workspaceId, "thread/start", {
      cwd: "/tmp/workspace",
      clientThreadId: "draft-1",
    });
    await helpers.requestJsonRpcControl(get as any, set as any, workspaceId, "turn/start", {
      threadId: "thread-1",
      clientMessageId: "message-1",
      input: [],
    });
    await helpers.requestJsonRpcControl(get as any, set as any, workspaceId, "turn/steer", {
      threadId: "thread-1",
      turnId: "turn-1",
      clientMessageId: "message-2",
      input: [],
    });
    await helpers.requestJsonRpcControl(
      get as any,
      set as any,
      workspaceId,
      "cowork/session/title/set",
      { threadId: "thread-1", title: "New title" },
    );

    expect(jsonRpcRequests.at(-6)?.options).toEqual({
      retryable: true,
      retryOnDisconnect: true,
    });
    expect(jsonRpcRequests.at(-5)?.options).toEqual({
      retryable: true,
      retryOnDisconnect: true,
    });
    expect(jsonRpcRequests.at(-4)?.options).toEqual({
      retryable: true,
      retryOnDisconnect: true,
    });
    expect(jsonRpcRequests.at(-3)?.options).toEqual({
      retryable: false,
      retryOnDisconnect: false,
    });
    expect(jsonRpcRequests.at(-2)?.options).toEqual({
      retryable: false,
      retryOnDisconnect: false,
    });
    expect(jsonRpcRequests.at(-1)?.options).toEqual({
      retryable: false,
      retryOnDisconnect: false,
    });
  });

  test("server-request responses are not marked retryable across reconnects", () => {
    const workspaceId = "ws-response-classification";
    const { get, set } = createState(workspaceId);
    const helpers = createControlSocketHelpers(deps);

    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    expect(respondToJsonRpcRequest(workspaceId, "ask-1", { answer: "yes" })).toBe(true);
    expect(jsonRpcResponses).toEqual([
      {
        id: "ask-1",
        result: { answer: "yes" },
        options: undefined,
      },
    ]);
  });

  test("re-runs control bootstrap after reconnect when the previous bootstrap is still in flight", async () => {
    const workspaceId = "ws-bootstrap-reconnect";
    const { get, set } = createState(workspaceId);
    const firstProviderRefresh = Promise.withResolvers<any>();
    let providerRefreshCalls = 0;

    jsonRpcHandlers.set("thread/list", async () => ({ threads: [] }));
    jsonRpcHandlers.set("cowork/session/state/read", async () => ({}));
    jsonRpcHandlers.set("cowork/provider/catalog/read", async () => ({}));
    jsonRpcHandlers.set("cowork/provider/authMethods/read", async () => ({}));
    jsonRpcHandlers.set("cowork/provider/status/refresh", async () => {
      providerRefreshCalls += 1;
      if (providerRefreshCalls === 1) {
        return await firstProviderRefresh.promise;
      }
      return {};
    });
    jsonRpcHandlers.set("cowork/mcp/servers/read", async () => ({}));
    jsonRpcHandlers.set("cowork/memory/list", async () => ({}));
    jsonRpcHandlers.set("cowork/skills/catalog/read", async () => ({}));
    jsonRpcHandlers.set("cowork/skills/list", async () => ({}));

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();

    expect(providerRefreshCalls).toBe(1);

    const socket = MockJsonRpcSocket.instances[0];
    expect(socket).toBeDefined();
    socket.reconnecting();
    await flushAsyncWork();
    socket.connect();
    await flushAsyncWork();

    expect(providerRefreshCalls).toBe(1);
    expect(helpers.__internal.getWorkspaceStateSnapshot(workspaceId).hasBootstrapPromise).toBe(
      true,
    );

    firstProviderRefresh.resolve({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushAsyncWork();

    expect(providerRefreshCalls).toBe(2);
    expect(
      jsonRpcRequests.filter((entry) => entry.method === "cowork/session/state/read"),
    ).toHaveLength(2);
  });

  test("stale profile catalog bootstrap reads do not overwrite fresher catalog state", async () => {
    const workspaceId = "ws-bootstrap-profile-catalog";
    const freshCatalog = agentProfilesCatalogEvent("Fresh Profile").catalog;
    const { state, get, set } = createState(workspaceId);
    state.workspaceRuntimeById[workspaceId].agentProfilesCatalog = freshCatalog;
    const staleRead = Promise.withResolvers<Record<string, unknown>>();

    jsonRpcHandlers.set("cowork/agentProfiles/catalog/read", async () => await staleRead.promise);

    const helpers = createControlSocketHelpers(deps);
    const socket = helpers.ensureControlSocket(get as any, set as any, workspaceId);
    expect(socket).toBeInstanceOf(MockJsonRpcSocket);
    (socket as MockJsonRpcSocket).connect();
    await flushAsyncWork();

    expect(
      jsonRpcRequests.some((entry) => entry.method === "cowork/agentProfiles/catalog/read"),
    ).toBe(true);

    bumpAgentProfilesCatalogGeneration(workspaceId);
    staleRead.resolve({ event: agentProfilesCatalogEvent("Stale Profile") });
    await flushAsyncWork();

    expect(
      state.workspaceRuntimeById[workspaceId].agentProfilesCatalog?.profiles[0]?.profile
        .displayName,
    ).toBe("Fresh Profile");
  });

  test("disposeWorkspaceControlState clears workspace-scoped lifecycle and bootstrap state", async () => {
    const workspaceId = "ws-dispose";
    const { state, get, set } = createState(workspaceId);
    const blockedProviderStatus = Promise.withResolvers<any>();
    jsonRpcHandlers.set(
      "cowork/provider/status/refresh",
      async () => await blockedProviderStatus.promise,
    );

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();

    expect(helpers.__internal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
      isDisposed: false,
      hasLifecycleCleanup: true,
      hasRouterCleanup: true,
      hasBootstrapPromise: true,
      hasStoreGetter: true,
      hasStoreSetter: true,
    });

    helpers.disposeWorkspaceControlState(workspaceId);

    expect(helpers.__internal.getWorkspaceStateSnapshot(workspaceId)).toEqual({
      isDisposed: true,
      hasLifecycleCleanup: false,
      hasRouterCleanup: false,
      hasBootstrapPromise: false,
      hasStoreGetter: false,
      hasStoreSetter: false,
    });
    expect(state.workspaceRuntimeById[workspaceId]?.controlSessionId).toBeNull();

    blockedProviderStatus.resolve({});
    await flushAsyncWork();
  });

  test("disposeWorkspaceControlState rejects pending plugin install waiters without store bindings", async () => {
    const workspaceId = "ws-plugin-dispose";
    const rejected = Promise.withResolvers<void>();
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install:workspace",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    const rejectedPromise = rejected.promise;
    helpers.disposeWorkspaceControlState(workspaceId);

    await expect(rejectedPromise).rejects.toThrow("Control connection closed");
    expect(RUNTIME.pluginInstallWaiters.has(workspaceId)).toBe(false);
  });

  test("disposeAllControlState rejects pending plugin install waiters with no other workspace state", async () => {
    const workspaceId = "ws-plugin-dispose-all";
    const rejected = Promise.withResolvers<void>();
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install:user",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    const rejectedPromise = rejected.promise;
    helpers.disposeAllControlState();

    await expect(rejectedPromise).rejects.toThrow("Control connection closed");
    expect(RUNTIME.pluginInstallWaiters.has(workspaceId)).toBe(false);
  });

  test("waitForControlSession waits for JSON-RPC control bootstrap to hydrate control state", async () => {
    const workspaceId = "ws-control-state";
    const { state, get, set } = createState(workspaceId);
    const sessionState = Promise.withResolvers<any>();
    jsonRpcHandlers.set("cowork/session/state/read", async () => await sessionState.promise);

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);

    let settled = false;
    const readyPromise = helpers
      .waitForControlSession(get as any, set as any, workspaceId, 1_000)
      .then((ready) => {
        settled = true;
        return ready;
      });

    await flushAsyncWork();
    expect(settled).toBe(false);
    expect(jsonRpcRequests.some((entry) => entry.method === "cowork/session/state/read")).toBe(
      true,
    );

    sessionState.resolve({
      events: [
        {
          type: "config_updated",
          sessionId: "control-session-1",
          config: {
            provider: "openai",
            model: "gpt-5.2",
            workingDirectory: "/tmp/workspace",
            uploadsDirectory: "/tmp/workspace/Custom Uploads",
          },
        },
        {
          type: "session_settings",
          sessionId: "control-session-1",
          enableMcp: false,
          enableMemory: true,
          memoryRequireApproval: false,
        },
        {
          type: "session_config",
          sessionId: "control-session-1",
          config: {
            yolo: false,
            observabilityEnabled: false,
            backupsEnabled: true,
            defaultBackupsEnabled: true,
            enableMemory: true,
            memoryRequireApproval: false,
            preferredChildModel: "gpt-5.2",
            childModelRoutingMode: "same-provider",
            preferredChildModelRef: "openai:gpt-5.2",
            allowedChildModelRefs: [],
            maxSteps: 100,
            featureFlags: {
              workspace: {
                REMOVEDUI: false,
              },
            },
          },
        },
      ],
    });

    expect(await readyPromise).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe("control-session-1");
    expect(state.workspaceRuntimeById[workspaceId].controlConfig).toEqual({
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
      uploadsDirectory: "/tmp/workspace/Custom Uploads",
    });
    expect(state.workspaceRuntimeById[workspaceId].controlEnableMcp).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionConfig?.preferredChildModel).toBe(
      "gpt-5.2",
    );
  });

  test("pending waiter diagnostics reflect in-flight JSON-RPC waits", async () => {
    const workspaceId = "ws-waiters";
    const { get, set } = createState(workspaceId);
    const ready = Promise.withResolvers<void>();
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: ready.promise,
      request: async () => ({}),
      respond: () => true,
      close: () => {},
    } as any);

    const helpers = createControlSocketHelpers(deps);
    const readyPromise = helpers.waitForControlSession(get as any, set as any, workspaceId, 1_000);
    expect(helpers.__internal.getPendingWaiterCounts().controlSessionWaiters).toBe(1);
    ready.resolve();
    expect(await readyPromise).toBe(true);
    expect(helpers.__internal.getPendingWaiterCounts().controlSessionWaiters).toBe(0);

    const sessions = Promise.withResolvers<any>();
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("thread/list");
      return await sessions.promise;
    });
    const sessionsPromise = helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);
    expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(1);
    sessions.resolve({
      threads: [makeThreadListEntry("session-1")],
    });
    expect((await sessionsPromise)?.map((entry: any) => entry.sessionId)).toEqual(["session-1"]);
    expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(0);

    const snapshot = Promise.withResolvers<any>();
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("thread/read");
      return await snapshot.promise;
    });
    const snapshotPromise = helpers.requestSessionSnapshot(
      get as any,
      set as any,
      workspaceId,
      "session-1",
    );
    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(1);
    snapshot.resolve({
      coworkSnapshot: {
        sessionId: "session-1",
        title: "Snapshot title",
      },
    });
    expect(await snapshotPromise).toEqual({
      sessionId: "session-1",
      title: "Snapshot title",
    });
    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(0);
  });
});
