import { describe, expect, test } from "bun:test";

import type { SessionEvent } from "../src/lib/wsProtocol";
import {
  createControlSocketHelpers,
  createState,
  deps,
  ensureWorkspaceJsonRpcSocket,
  flushAsyncWork,
  jsonRpcHandlers,
  jsonRpcRequests,
  MockJsonRpcSocket,
  makeThreadListEntry,
  persistCalls,
  RUNTIME,
  registerControlSocketLifecycleHooks,
} from "./control-socket.harness";

describe("control socket lifecycle races", () => {
  registerControlSocketLifecycleHooks();

  test("a cold session-list caller receives its result when opening the socket starts bootstrap", async () => {
    const workspaceId = "ws-cold-list";
    const { state, get, set } = createState(workspaceId);
    jsonRpcHandlers.set("thread/list", () => ({ threads: [makeThreadListEntry("session-cold")] }));
    jsonRpcHandlers.set("cowork/session/state/read", () => ({
      event: {
        type: "session_settings",
        sessionId: "cold-control",
        enableMcp: false,
        enableMemory: true,
        memoryRequireApproval: false,
      },
    }));
    const helpers = createControlSocketHelpers(deps);
    const controller = new AbortController();
    try {
      const sessions = await helpers.requestWorkspaceSessions(
        get as never,
        set as never,
        workspaceId,
        { signal: controller.signal },
      );
      expect(sessions?.map((session) => session.sessionId)).toEqual(["session-cold"]);
      expect(await helpers.waitForControlSession(get as never, set as never, workspaceId)).toBe(
        true,
      );
      expect(state.threads.map((thread: { id: string }) => thread.id)).toEqual(["session-cold"]);
      expect(state.workspaces[0].defaultEnableMcp).toBe(false);
      expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe("cold-control");
      expect(jsonRpcRequests.filter((request) => request.method === "thread/list")).toHaveLength(1);
      expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(0);
    } finally {
      helpers.disposeWorkspaceControlState(workspaceId);
    }
  });

  test("cancelling the cold caller does not cancel bootstrap session hydration", async () => {
    const workspaceId = "ws-cold-list-abort";
    const { state, get, set } = createState(workspaceId);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<{ threads: ReturnType<typeof makeThreadListEntry>[] }>();
    jsonRpcHandlers.set("thread/list", () => {
      started.resolve();
      return response.promise;
    });
    const helpers = createControlSocketHelpers(deps);
    const controller = new AbortController();
    const pending = helpers.requestWorkspaceSessions(get as never, set as never, workspaceId, {
      signal: controller.signal,
    });
    try {
      await started.promise;
      controller.abort();
      response.resolve({ threads: [makeThreadListEntry("session-bootstrap")] });
      expect(await pending).toBeNull();
      expect(await helpers.waitForControlSession(get as never, set as never, workspaceId)).toBe(
        true,
      );
      expect(state.threads.map((thread: { id: string }) => thread.id)).toEqual([
        "session-bootstrap",
      ]);
      expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(0);
    } finally {
      response.resolve({ threads: [] });
      await pending;
      helpers.disposeWorkspaceControlState(workspaceId);
    }
  });

  test("a settled response from a replaced socket cannot apply control events", async () => {
    const workspaceId = "ws-replaced-event";
    const { state, get, set } = createState(workspaceId);
    const response = Promise.withResolvers<{ event: SessionEvent }>();
    jsonRpcHandlers.set("cowork/session/state/read", () => response.promise);
    const helpers = createControlSocketHelpers(deps);
    let appliedEvents = 0;
    const detail: { message?: string } = {};
    const pending = helpers.requestJsonRpcControlEvent(
      get as never,
      set as never,
      workspaceId,
      "cowork/session/state/read",
      { cwd: "/tmp/workspace" },
      detail,
      {
        beforeApplyEvent: () => {
          appliedEvents += 1;
        },
      },
    );
    expect(jsonRpcRequests).toHaveLength(1);

    // The transport has already received the reply; closing it cannot reject
    // this settled request before the store continuation applies its events.
    response.resolve({
      event: {
        type: "session_settings",
        sessionId: "old-control",
        enableMcp: false,
        enableMemory: true,
        memoryRequireApproval: false,
      },
    });
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://replacement";
    ensureWorkspaceJsonRpcSocket(get as never, set as never, workspaceId);
    const persistedBeforeReply = persistCalls;

    const ok = await pending;
    expect(state.workspaces[0].defaultEnableMcp).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe(`jsonrpc:${workspaceId}`);
    expect(appliedEvents).toBe(0);
    expect(persistCalls).toBe(persistedBeforeReply);
    expect(ok).toBe(false);
    expect(detail.message).toContain("changed");
  });

  test("a snapshot from a replaced socket cannot hydrate the current connection", async () => {
    const workspaceId = "ws-replaced-snapshot";
    const { state, get, set } = createState(workspaceId);
    const response = Promise.withResolvers<{
      coworkSnapshot: { sessionId: string; title: string };
    }>();
    jsonRpcHandlers.set("thread/read", () => response.promise);
    const helpers = createControlSocketHelpers(deps);
    const pending = helpers.requestSessionSnapshot(
      get as never,
      set as never,
      workspaceId,
      "session-1",
    );
    expect(jsonRpcRequests).toHaveLength(1);

    response.resolve({ coworkSnapshot: { sessionId: "session-1", title: "Old server snapshot" } });
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://replacement";
    ensureWorkspaceJsonRpcSocket(get as never, set as never, workspaceId);

    expect(await pending).toBeNull();
    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(0);
  });

  test("a raw control request rejects a reply from a replaced socket", async () => {
    const workspaceId = "ws-replaced-control-read";
    const { state, get, set } = createState(workspaceId);
    const response = Promise.withResolvers<Record<string, unknown>>();
    jsonRpcHandlers.set("cowork/provider/usage/read", () => response.promise);
    const helpers = createControlSocketHelpers(deps);
    const pending = helpers.requestJsonRpcControl(
      get as never,
      set as never,
      workspaceId,
      "cowork/provider/usage/read",
      { cwd: "/tmp/workspace" },
    );
    expect(jsonRpcRequests).toHaveLength(1);

    response.resolve({ usage: "old-server" });
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://replacement";
    ensureWorkspaceJsonRpcSocket(get as never, set as never, workspaceId);

    await expect(pending).rejects.toThrow("changed");
  });

  test("waiting for a bootstrap reports failure if the workspace is disposed before it finishes", async () => {
    const workspaceId = "ws-disposed-bootstrap-wait";
    const { get, set } = createState(workspaceId);
    const response = Promise.withResolvers<Record<string, unknown>>();
    jsonRpcHandlers.set("thread/list", () => ({ threads: [] }));
    jsonRpcHandlers.set("cowork/session/state/read", () => response.promise);
    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as never, set as never, workspaceId);
    const pending = helpers.waitForControlSession(get as never, set as never, workspaceId);
    await flushAsyncWork();
    expect(helpers.__internal.getPendingWaiterCounts().controlSessionWaiters).toBe(1);

    response.resolve({});
    helpers.disposeWorkspaceControlState(workspaceId);

    expect(await pending).toBe(false);
    expect(helpers.__internal.getPendingWaiterCounts().controlSessionWaiters).toBe(0);
  });

  test("a readiness waiter includes the bootstrap queued by a reconnect", async () => {
    const workspaceId = "ws-reconnect-bootstrap-wait";
    const { get, set } = createState(workspaceId);
    const oldStatus = Promise.withResolvers<Record<string, unknown>>();
    const newStatus = Promise.withResolvers<Record<string, unknown>>();
    let statusReads = 0;
    jsonRpcHandlers.set("thread/list", () => ({ threads: [] }));
    jsonRpcHandlers.set("cowork/provider/status/refresh", () => {
      statusReads += 1;
      return statusReads === 1 ? oldStatus.promise : newStatus.promise;
    });
    const helpers = createControlSocketHelpers(deps);
    const socket = helpers.ensureControlSocket(
      get as never,
      set as never,
      workspaceId,
    ) as MockJsonRpcSocket;
    let settled = false;
    const pending = helpers
      .waitForControlSession(get as never, set as never, workspaceId)
      .then((ready) => {
        settled = true;
        return ready;
      });
    await flushAsyncWork();
    socket.reconnecting();
    socket.connect();

    try {
      oldStatus.resolve({});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(statusReads).toBe(2);
      expect(settled).toBe(false);
      newStatus.resolve({});
      expect(await pending).toBe(true);
    } finally {
      oldStatus.resolve({});
      newStatus.resolve({});
      await pending;
      helpers.disposeWorkspaceControlState(workspaceId);
    }
  });

  test("a queued bootstrap from a disposed workspace cannot replace its new bootstrap", async () => {
    const workspaceId = "ws-replaced-bootstrap-queue";
    const { state, get, set } = createState(workspaceId);
    const oldStatus = Promise.withResolvers<Record<string, unknown>>();
    const newStatus = Promise.withResolvers<Record<string, unknown>>();
    let statusReads = 0;
    jsonRpcHandlers.set("thread/list", () => ({ threads: [] }));
    jsonRpcHandlers.set("cowork/provider/status/refresh", () => {
      statusReads += 1;
      return statusReads === 1 ? oldStatus.promise : newStatus.promise;
    });
    const helpers = createControlSocketHelpers(deps);
    const oldSocket = helpers.ensureControlSocket(
      get as never,
      set as never,
      workspaceId,
    ) as MockJsonRpcSocket;
    await flushAsyncWork();
    oldSocket.reconnecting();
    oldSocket.connect();
    expect(statusReads).toBe(1);

    helpers.disposeWorkspaceControlState(workspaceId);
    helpers.reactivateWorkspaceControlState(workspaceId);
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://replacement";
    state.workspaceRuntimeById[workspaceId].selectedSkillName = "current-skill";
    helpers.ensureControlSocket(get as never, set as never, workspaceId);
    expect(statusReads).toBe(2);

    try {
      oldStatus.resolve({});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(statusReads).toBe(2);
      expect(jsonRpcRequests.filter((request) => request.method === "cowork/skills/read")).toEqual(
        [],
      );
      expect(helpers.__internal.getWorkspaceStateSnapshot(workspaceId).hasBootstrapPromise).toBe(
        true,
      );
    } finally {
      oldStatus.resolve({});
      newStatus.resolve({});
      await new Promise<void>((resolve) => setImmediate(resolve));
      helpers.disposeWorkspaceControlState(workspaceId);
    }
  });

  test("a retryable read remains valid across reconnecting the same shared socket", async () => {
    const workspaceId = "ws-same-socket-reconnect";
    const { state, get, set } = createState(workspaceId);
    const response = Promise.withResolvers<{ event: SessionEvent }>();
    jsonRpcHandlers.set("cowork/session/state/read", () => response.promise);
    const helpers = createControlSocketHelpers(deps);
    const pending = helpers.requestJsonRpcControlEvent(
      get as never,
      set as never,
      workspaceId,
      "cowork/session/state/read",
      { cwd: "/tmp/workspace" },
    );
    const socket = MockJsonRpcSocket.instances[0];
    socket.reconnecting();
    socket.connect();
    response.resolve({
      event: {
        type: "session_settings",
        sessionId: "resumed-control",
        enableMcp: false,
        enableMemory: true,
        memoryRequireApproval: false,
      },
    });

    expect(await pending).toBe(true);
    expect(RUNTIME.jsonRpcSockets.get(workspaceId)).toBe(socket as never);
    expect(state.workspaces[0].defaultEnableMcp).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe("resumed-control");
  });

  test("duplicate list-change notifications in one batch share a refresh", async () => {
    const workspaceId = "ws-duplicate-list-notifications";
    const { get, set } = createState(workspaceId);
    jsonRpcHandlers.set("thread/list", () => ({ threads: [] }));
    const helpers = createControlSocketHelpers(deps);
    const socket = helpers.ensureControlSocket(
      get as never,
      set as never,
      workspaceId,
    ) as MockJsonRpcSocket;
    expect(await helpers.waitForControlSession(get as never, set as never, workspaceId)).toBe(true);
    jsonRpcRequests.length = 0;

    for (let i = 0; i < 3; i += 1) {
      socket.opts.onNotification?.({ method: "workspace/listChanged", params: { revision: 7 } });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(jsonRpcRequests.filter((request) => request.method === "thread/list")).toHaveLength(1);
    helpers.disposeWorkspaceControlState(workspaceId);
  });

  test("notifications from a replaced socket cannot overwrite the new control session", async () => {
    const workspaceId = "ws-replaced-notification";
    const { state, get, set } = createState(workspaceId);
    jsonRpcHandlers.set("thread/list", () => ({ threads: [] }));
    const helpers = createControlSocketHelpers(deps);
    const oldSocket = helpers.ensureControlSocket(
      get as never,
      set as never,
      workspaceId,
    ) as MockJsonRpcSocket;
    expect(await helpers.waitForControlSession(get as never, set as never, workspaceId)).toBe(true);
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://replacement";
    const newSocket = helpers.ensureControlSocket(
      get as never,
      set as never,
      workspaceId,
    ) as MockJsonRpcSocket;
    expect(await helpers.waitForControlSession(get as never, set as never, workspaceId)).toBe(true);
    const event: SessionEvent = {
      type: "session_settings",
      sessionId: "old-control",
      enableMcp: false,
      enableMemory: true,
      memoryRequireApproval: false,
    };
    oldSocket.opts.onNotification?.({ method: "cowork/control/event", params: event });
    expect(state.workspaces[0].defaultEnableMcp).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe(`jsonrpc:${workspaceId}`);

    newSocket.opts.onNotification?.({
      method: "cowork/control/event",
      params: { ...event, sessionId: "new-control" },
    });
    expect(state.workspaces[0].defaultEnableMcp).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].controlSessionId).toBe("new-control");
    helpers.disposeWorkspaceControlState(workspaceId);
  });
});
