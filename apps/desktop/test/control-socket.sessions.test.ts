import { describe, expect, test } from "bun:test";
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
  MockJsonRpcSocket,
  makeThread,
  makeThreadListEntry,
  persistCalls,
  RUNTIME,
  registerControlSocketLifecycleHooks,
  setJsonRpcSocketOverride,
} from "./control-socket.harness";

describe("control socket helpers over JSON-RPC", () => {
  registerControlSocketLifecycleHooks();

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

  test("requestWorkspaceSessions preserves the legacy transcript mapping for runtime-backed local threads", async () => {
    const workspaceId = "ws-legacy-thread";
    const localThreadId = "local-thread-1";
    const { state, get, set } = createState(workspaceId, {
      threads: [
        {
          ...makeThread(localThreadId, workspaceId),
          sessionId: null,
        },
      ],
      threadRuntimeById: {
        [localThreadId]: {
          sessionId: "session-keep",
        },
      },
    });

    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("thread/list");
      return {
        threads: [makeThreadListEntry("session-keep")],
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const sessions = await helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);

    expect(sessions?.map((session) => session.sessionId)).toEqual(["session-keep"]);
    expect(state.threads.filter((thread: any) => thread.workspaceId === workspaceId)).toEqual([
      expect.objectContaining({
        id: localThreadId,
        sessionId: "session-keep",
        legacyTranscriptId: localThreadId,
      }),
    ]);
  });

  test("requestWorkspaceSessions does not duplicate runtime-backed local threads that already carry a legacy transcript id", async () => {
    const workspaceId = "ws-existing-legacy-thread";
    const localThreadId = "local-thread-2";
    const { state, get, set } = createState(workspaceId, {
      threads: [
        {
          ...makeThread(localThreadId, workspaceId),
          sessionId: null,
          legacyTranscriptId: "legacy-thread-2",
        },
      ],
      threadRuntimeById: {
        [localThreadId]: {
          sessionId: "session-keep-2",
        },
      },
    });

    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("thread/list");
      return {
        threads: [makeThreadListEntry("session-keep-2")],
      };
    });

    const helpers = createControlSocketHelpers(deps);
    await helpers.requestWorkspaceSessions(get as any, set as any, workspaceId);

    expect(state.threads.filter((thread: any) => thread.workspaceId === workspaceId)).toEqual([
      expect.objectContaining({
        id: localThreadId,
        sessionId: "session-keep-2",
        legacyTranscriptId: "legacy-thread-2",
      }),
    ]);
  });

  test("requestSessionSnapshot reads coworkSnapshot from thread/read", async () => {
    const workspaceId = "ws-snapshot";
    const { get, set } = createState(workspaceId);
    installFakeSocket(workspaceId, async (method, params) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ threadId: "session-1" });
      return {
        coworkSnapshot: {
          sessionId: "session-1",
          title: "Snapshot title",
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const snapshot = await helpers.requestSessionSnapshot(
      get as any,
      set as any,
      workspaceId,
      "session-1",
    );
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
});
