import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../../../src/shared/tasks";
import { createThreadModelStreamRuntime } from "../src/app/store.feedMapping";
import type { SessionSnapshot } from "../src/app/types";
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

  test("removeWorkspace drops the deleted workspace from the workspace list", async () => {
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
    }));

    await useAppStore.getState().removeWorkspace(managementWorkspaceId);

    const state = useAppStore.getState();
    expect(state.workspaces.some((workspace) => workspace.id === managementWorkspaceId)).toBe(
      false,
    );
  });

  test("removeWorkspace releases its thread and workspace caches without clearing another workspace", async () => {
    primeWorkspaceConnection();
    const removed = seedConnectedThread();
    const removedChild = seedConnectedThread();
    const retainedWorkspaceId = `retained-${workspaceId}`;
    const retainedPath = "/tmp/retained-workspace";
    useAppStore.setState((state) => ({
      workspaces: [
        ...state.workspaces,
        { ...state.workspaces[0]!, id: retainedWorkspaceId, path: retainedPath },
      ],
      selectedWorkspaceId: retainedWorkspaceId,
    }));
    primeWorkspaceConnection();
    const retained = seedConnectedThread();
    const allThreads = [removed, removedChild, retained];
    const makeTask = (id: string, workspacePath: string): TaskRecord => ({
      id,
      workspacePath,
      title: id,
      objective: "Keep task state scoped to its workspace",
      status: "working",
      revision: 1,
      reviewRequired: true,
      createdAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
      threadCount: 0,
      completedWorkItemCount: 0,
      totalWorkItemCount: 0,
      activeBlockerCount: 0,
      pendingQuestionCount: 0,
      blockingQuestionCount: 0,
      requirements: [],
      threads: [],
      workItems: [],
      decisions: [],
      questions: [],
      artifacts: [],
      blockers: [],
      activity: [],
      latestCheckpoint: null,
    });
    const removedTask = makeTask(`task-${workspaceId}`, "/tmp/workspace");
    const retainedTask = makeTask(`task-${retainedWorkspaceId}`, retainedPath);

    for (const { threadId, sessionId } of allThreads) {
      const stream = createThreadModelStreamRuntime();
      stream.assistantTextHistoryInTurn.push("Retained streamed content");
      RUNTIME.modelStreamByThread.set(threadId, stream);
      RUNTIME.optimisticUserMessageIds.set(threadId, new Set(["optimistic-message"]));
      RUNTIME.pendingThreadMessages.set(threadId, [{ text: "Queued message" }]);
      RUNTIME.pendingThreadAttachments.set(threadId, [[]]);
      RUNTIME.pendingThreadReferences.set(threadId, [[]]);
      RUNTIME.pendingThreadSteers.set(threadId, new Map());
      RUNTIME.threadSelectionRequests.set(threadId, 1);
      RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
        mode: "auto",
        draftModelSelection: null,
      });
      for (const cacheId of [sessionId, `live-${sessionId}`]) {
        const snapshot = makeSessionSnapshot(cacheId) as SessionSnapshot;
        RUNTIME.sessionSnapshots.set(cacheId, { fingerprint: snapshot, snapshot });
      }
      useAppStore.setState((state) => ({
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...state.threadRuntimeById[threadId]!,
            sessionId: `live-${sessionId}`,
            feed: [
              {
                id: "cached-message",
                kind: "message",
                role: "assistant",
                ts: "now",
                text: "Cached feed",
              },
            ],
          },
        },
        latestTodosByThreadId: {
          ...state.latestTodosByThreadId,
          [threadId]: [{ content: "Pending work", status: "pending" }],
        },
        interactionsByThread: {
          ...state.interactionsByThread,
          [threadId]: [
            {
              kind: "ask",
              requestId: "ask-1",
              receivedSequence: 1,
              status: "pending",
              question: "Continue?",
            },
          ],
        },
      }));
    }
    for (const id of [workspaceId, retainedWorkspaceId]) {
      RUNTIME.agentProfilesCatalogGenerations.set(id, 2);
      useAppStore.setState((state) => ({
        workspaceExplorerById: {
          ...state.workspaceExplorerById,
          [id]: {
            rootPath: id,
            currentPath: id,
            entries: [],
            selectedPath: id,
            loading: false,
            error: null,
            requestId: 1,
          },
        },
        workspaceExplorerRefreshById: { ...state.workspaceExplorerRefreshById, [id]: 3 },
      }));
    }
    useAppStore.setState({
      selectedThreadId: retained.threadId,
      agentViewerThreadId: removed.threadId,
      newTaskWorkspaceId: workspaceId,
      quickChatPreparedWorkspaceId: workspaceId,
      taskSummariesByWorkspaceId: {
        [workspaceId]: [removedTask],
        [retainedWorkspaceId]: [retainedTask],
      },
      taskListLoadingByWorkspaceId: { [workspaceId]: true, [retainedWorkspaceId]: true },
      tasksById: { [removedTask.id]: removedTask, [retainedTask.id]: retainedTask },
      taskLifecycleRequestByTaskId: {
        [removedTask.id]: { action: "retry", expectedRevision: 1, requestId: "removed-retry" },
        [retainedTask.id]: { action: "retry", expectedRevision: 1, requestId: "retained-retry" },
      },
    });
    const before = useAppStore.getState();
    const retainedStream = RUNTIME.modelStreamByThread.get(retained.threadId);

    try {
      await useAppStore.getState().removeWorkspace(workspaceId);

      const state = useAppStore.getState();
      for (const key of [
        "threadRuntimeById",
        "latestTodosByThreadId",
        "interactionsByThread",
      ] as const) {
        expect(state[key][removed.threadId]).toBeUndefined();
        expect(state[key][removedChild.threadId]).toBeUndefined();
        expect(state[key][retained.threadId]).toBe(before[key][retained.threadId]);
      }
      for (const key of [
        "workspaceRuntimeById",
        "workspaceExplorerById",
        "workspaceExplorerRefreshById",
        "taskSummariesByWorkspaceId",
        "taskListLoadingByWorkspaceId",
      ] as const) {
        expect(state[key][workspaceId]).toBeUndefined();
        expect(state[key][retainedWorkspaceId]).toBe(before[key][retainedWorkspaceId]);
      }
      for (const map of [
        RUNTIME.optimisticUserMessageIds,
        RUNTIME.pendingThreadMessages,
        RUNTIME.pendingThreadAttachments,
        RUNTIME.pendingThreadReferences,
        RUNTIME.pendingThreadSteers,
        RUNTIME.threadSelectionRequests,
        RUNTIME.pendingWorkspaceDefaultApplyByThread,
        RUNTIME.modelStreamByThread,
      ]) {
        expect(map.has(removed.threadId)).toBe(false);
        expect(map.has(removedChild.threadId)).toBe(false);
        expect(map.has(retained.threadId)).toBe(true);
      }
      for (const { sessionId } of [removed, removedChild]) {
        expect(RUNTIME.sessionSnapshots.has(sessionId)).toBe(false);
        expect(RUNTIME.sessionSnapshots.has(`live-${sessionId}`)).toBe(false);
      }
      expect(RUNTIME.sessionSnapshots.has(retained.sessionId)).toBe(true);
      expect(RUNTIME.sessionSnapshots.has(`live-${retained.sessionId}`)).toBe(true);
      expect(RUNTIME.modelStreamByThread.get(retained.threadId)).toBe(retainedStream);
      expect(RUNTIME.agentProfilesCatalogGenerations.has(workspaceId)).toBe(false);
      expect(RUNTIME.agentProfilesCatalogGenerations.get(retainedWorkspaceId)).toBe(2);
      expect(state.tasksById[removedTask.id]).toBeUndefined();
      expect(state.tasksById[retainedTask.id]).toBe(retainedTask);
      expect(state.taskLifecycleRequestByTaskId[removedTask.id]).toBeUndefined();
      expect(state.taskLifecycleRequestByTaskId[retainedTask.id]).toBe(
        before.taskLifecycleRequestByTaskId[retainedTask.id],
      );
      expect(state.selectedWorkspaceId).toBe(retainedWorkspaceId);
      expect(state.selectedThreadId).toBe(retained.threadId);
      expect(state.agentViewerThreadId).toBeNull();
      expect(state.newTaskWorkspaceId).toBeNull();
      expect(state.quickChatPreparedWorkspaceId).toBeNull();
    } finally {
      for (const { threadId, sessionId } of allThreads) {
        RUNTIME.pendingThreadReferences.delete(threadId);
        RUNTIME.pendingThreadSteers.delete(threadId);
        RUNTIME.sessionSnapshots.delete(sessionId);
        RUNTIME.sessionSnapshots.delete(`live-${sessionId}`);
      }
      RUNTIME.agentProfilesCatalogGenerations.delete(workspaceId);
      RUNTIME.agentProfilesCatalogGenerations.delete(retainedWorkspaceId);
      useAppStore.setState({
        tasksById: {},
        taskSummariesByWorkspaceId: {},
        taskListLoadingByWorkspaceId: {},
        taskLifecycleRequestByTaskId: {},
        agentViewerThreadId: null,
        newTaskWorkspaceId: null,
        quickChatPreparedWorkspaceId: null,
        workspaceExplorerRefreshById: {},
      });
    }
  });

  test("session_config preserves a pending explicit reasoning effort until the server confirms it", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread({
      sessionConfig: {
        providerOptions: {
          openai: { reasoningEffort: "medium" },
        },
      },
    });
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances.at(-1);
    if (!socket) throw new Error("expected JSON-RPC socket");

    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          composerReasoningEffort: "xhigh",
        },
      },
    }));

    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
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
        toolOutputOverflowChars: 25000,
        providerOptions: {
          openai: { reasoningEffort: "medium" },
        },
      },
    });
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBe(
      "xhigh",
    );

    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
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
        toolOutputOverflowChars: 25000,
        providerOptions: {
          openai: { reasoningEffort: "xhigh" },
        },
      },
    });
    await flushAsyncWork();

    const confirmedRt = useAppStore.getState().threadRuntimeById[threadId];
    expect(confirmedRt?.composerReasoningEffort).toBeNull();
    // The runtime effort is synced to the confirmed value so the selector
    // (which prefers runtime over config) does not snap back to the old effort.
    expect(confirmedRt?.requestedReasoningEffort).toBe("xhigh");
    expect(confirmedRt?.effectiveReasoningEffort).toBe("xhigh");
  });

  test("session_config clears a pending effort when the server settles a different one", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread({
      sessionConfig: {
        providerOptions: {
          openai: { reasoningEffort: "medium" },
        },
      },
    });
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances.at(-1);
    if (!socket) throw new Error("expected JSON-RPC socket");

    // The user optimistically picked xhigh, but the server settles on "low"
    // (e.g. clamped/rejected). The pending value must not stay stuck.
    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          composerReasoningEffort: "xhigh",
        },
      },
    }));

    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
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
        toolOutputOverflowChars: 25000,
        providerOptions: {
          openai: { reasoningEffort: "low" },
        },
      },
    });
    await flushAsyncWork();

    const rt = useAppStore.getState().threadRuntimeById[threadId];
    expect(rt?.composerReasoningEffort).toBeNull();
    // Runtime synced to the server's authoritative value, not the optimistic one.
    expect(rt?.requestedReasoningEffort).toBe("low");
    expect(rt?.effectiveReasoningEffort).toBe("low");
  });

  test("session_config clears the stale runtime effort when the settled config carries no effort", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread({
      sessionConfig: {
        providerOptions: {
          openai: { reasoningEffort: "medium" },
        },
      },
    });
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances.at(-1);
    if (!socket) throw new Error("expected JSON-RPC socket");

    // The prior turn ran at xhigh (stale runtime effort), and the user then
    // optimistically picked "high". The server settles a config with NO
    // reasoningEffort (e.g. switched to a non-reasoning model or cleared it).
    // Because the selector prefers runtime over config, the stale runtime xhigh
    // must be cleared or the composer would keep showing xhigh forever.
    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          composerReasoningEffort: "high",
          requestedReasoningEffort: "xhigh",
          effectiveReasoningEffort: "xhigh",
        },
      },
    }));

    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
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
        toolOutputOverflowChars: 25000,
        providerOptions: {
          openai: {},
        },
      },
    });
    await flushAsyncWork();

    const rt = useAppStore.getState().threadRuntimeById[threadId];
    expect(rt?.composerReasoningEffort).toBeNull();
    // Stale runtime effort cleared so the selector falls through to config/default.
    expect(rt?.requestedReasoningEffort).toBeNull();
    expect(rt?.effectiveReasoningEffort).toBeNull();
  });

  test("session_config compares pending reasoning effort against the draft composer provider", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    ensureThreadSocket(
      useAppStore.getState as any,
      useAppStore.setState as any,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances.at(-1);
    if (!socket) throw new Error("expected JSON-RPC socket");

    // Live session config points at a provider without composer reasoning
    // options, while the composer draft targets openai.
    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          config: {
            ...(state.threadRuntimeById[threadId] as any).config,
            provider: "anthropic",
            model: "claude-opus-4-8",
          },
          draftComposerProvider: "openai",
          draftComposerModel: "gpt-5.2",
          composerReasoningEffort: "xhigh",
        } as any,
      },
    }));

    const baseConfig = {
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
      toolOutputOverflowChars: 25000,
    };

    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
      config: {
        ...baseConfig,
        providerOptions: { openai: { reasoningEffort: "medium" } },
      },
    });
    await flushAsyncWork();

    // Unconfirmed for the draft provider: the pending effort must survive
    // even though the live config provider has no reasoning options.
    expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBe(
      "xhigh",
    );

    socket.notify("cowork/session/config", {
      type: "session_config",
      sessionId,
      config: {
        ...baseConfig,
        providerOptions: { openai: { reasoningEffort: "xhigh" } },
      },
    });
    await flushAsyncWork();

    expect(useAppStore.getState().threadRuntimeById[threadId]?.composerReasoningEffort).toBeNull();
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
