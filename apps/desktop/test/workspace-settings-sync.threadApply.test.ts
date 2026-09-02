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

  test("applyWorkspaceDefaultsToThread defers auto apply until session settings hydrate", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    const hydratedRuntime = useAppStore.getState().threadRuntimeById[threadId];
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultEnableMcp: false,
            }
          : workspace,
      ),
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          sessionConfig: null,
          enableMcp: null,
        },
      },
    }));
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "auto");

    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId)).toEqual({
      mode: "auto",
      draftModelSelection: null,
      inFlight: false,
      waitingForHydration: true,
    });

    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          sessionConfig: hydratedRuntime?.sessionConfig ?? null,
          enableMcp: hydratedRuntime?.enableMcp ?? true,
        },
      },
    }));

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "auto");

    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(1);
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(threadId)).toBe(false);
  });

  for (const queuedBeforeResume of [false, true]) {
    test(`resumed sends do not wait for optional session config hydration (queued=${queuedBeforeResume})`, async () => {
      primeWorkspaceConnection();
      const { threadId, sessionId } = seedConnectedThread();
      const hydratedConfig = useAppStore.getState().threadRuntimeById[threadId]?.sessionConfig;
      useAppStore.setState((state) => ({
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, userName: "Resume defaults" } : workspace,
        ),
        threadRuntimeById: {
          ...state.threadRuntimeById,
          [threadId]: {
            ...state.threadRuntimeById[threadId],
            sessionConfig: null,
            enableMcp: null,
          },
        },
      }));
      const text = "Continue with the existing session";
      const clientMessageId = "resumed-message";
      if (queuedBeforeResume) {
        RUNTIME.pendingThreadMessages.set(threadId, [{ text, clientMessageId }]);
      }
      jsonRpcRequests.length = 0;
      ensureThreadSocket(
        useAppStore.getState as never,
        useAppStore.setState as never,
        threadId,
        "ws://mock",
        queuedBeforeResume ? text : undefined,
        queuedBeforeResume,
      );
      await flushAsyncWork();
      if (!queuedBeforeResume) {
        expect(
          await useAppStore.getState().sendMessage(text, "reject", undefined, undefined, {
            targetThreadId: threadId,
            clientMessageId,
          }),
        ).toBe(true);
        await flushAsyncWork();
      }

      expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
      expect(latestRequest("turn/start")?.params).toMatchObject({
        threadId: sessionId,
        clientMessageId,
        input: [{ type: "text", text }],
      });
      expect(RUNTIME.pendingThreadMessages.get(threadId) ?? []).toHaveLength(0);
      expect(useAppStore.getState().threadRuntimeById[threadId]?.sessionConfig).toBeNull();

      // A later real snapshot still reconciles defaults, but never mid-turn.
      const socket = MockJsonRpcSocket.instances.at(-1);
      if (!socket) throw new Error("expected JSON-RPC socket");
      socket.notify("turn/started", {
        threadId: sessionId,
        turn: { id: "resumed-turn", status: "inProgress", items: [] },
      });
      socket.notify("cowork/session/config", {
        type: "session_config",
        sessionId,
        config: hydratedConfig,
      });
      await flushAsyncWork();
      expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
      socket.notify("turn/completed", {
        threadId: sessionId,
        turn: { id: "resumed-turn", status: "completed" },
      });
      await flushAsyncWork();
      expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
        threadId: sessionId,
        config: { userName: "Resume defaults" },
      });
      expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(threadId)).toBe(false);
    });
  }

  test("thread defaults apply the latest change queued while an earlier apply is in flight", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    const firstResponse = createDeferred<unknown>();
    let applyCount = 0;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async (params) => {
      applyCount += 1;
      if (applyCount === 1) return await firstResponse.promise;
      return {
        event: {
          type: "session_config",
          sessionId,
          config: { userName: (params as { config: { userName: string } }).config.userName },
        },
      };
    });
    const setUserName = (userName: string) =>
      useAppStore.setState((state) => ({
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, userName } : workspace,
        ),
      }));
    setUserName("First");
    const first = useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();
    expect(applyCount).toBe(1);
    setUserName("Latest");
    const second = useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    firstResponse.resolve({
      event: { type: "session_config", sessionId, config: { userName: "First" } },
    });
    await Promise.all([first, second]);
    await flushAsyncWork();

    expect(applyCount).toBe(2);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      threadId: sessionId,
      config: { userName: "Latest" },
    });
    expect(useAppStore.getState().threadRuntimeById[threadId]?.sessionConfig?.userName).toBe(
      "Latest",
    );
    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.has(threadId)).toBe(false);
  });

  test("a queued successor defaults update reaches the server before a queued message", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    ensureThreadSocket(
      useAppStore.getState as never,
      useAppStore.setState as never,
      threadId,
      "ws://mock",
    );
    await flushAsyncWork();
    const socket = MockJsonRpcSocket.instances.at(-1);
    if (!socket) throw new Error("expected JSON-RPC socket");

    const firstResponse = createDeferred<unknown>();
    const latestResponse = createDeferred<unknown>();
    let applyCount = 0;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      applyCount += 1;
      return await (applyCount === 1 ? firstResponse.promise : latestResponse.promise);
    });
    const setUserName = (userName: string) =>
      useAppStore.setState((state) => ({
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, userName } : workspace,
        ),
      }));
    jsonRpcRequests.length = 0;
    setUserName("First");
    const first = useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();
    setUserName("Latest");
    const latest = useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    RUNTIME.pendingThreadMessages.set(threadId, [{ text: "Run with the latest defaults" }]);

    socket.notify("turn/completed", {
      threadId: sessionId,
      turn: { id: "previous-turn", status: "completed" },
    });
    await flushAsyncWork();
    const sentBeforeFirstAcknowledgement = requestsFor("turn/start").length;

    firstResponse.resolve({
      event: { type: "session_config", sessionId, config: { userName: "First" } },
    });
    await flushAsyncWork();
    const latestWasDispatched = applyCount === 2;

    // Once the successor has been dispatched, server-side mutation ordering is
    // sufficient: its acknowledgement must not become a blanket send barrier.
    socket.notify("turn/completed", {
      threadId: sessionId,
      turn: { id: "previous-turn", status: "completed" },
    });
    await flushAsyncWork();
    const sentBeforeLatestAcknowledgement = requestsFor("turn/start").length;
    latestResponse.resolve({
      event: { type: "session_config", sessionId, config: { userName: "Latest" } },
    });
    await Promise.all([first, latest]);
    await flushAsyncWork();

    expect(sentBeforeFirstAcknowledgement).toBe(0);
    expect(latestWasDispatched).toBe(true);
    expect(sentBeforeLatestAcknowledgement).toBe(1);
    expect(
      jsonRpcRequests
        .filter((request) =>
          ["cowork/session/defaults/apply", "turn/start"].includes(request.method),
        )
        .map((request) => request.method),
    ).toEqual(["cowork/session/defaults/apply", "cowork/session/defaults/apply", "turn/start"]);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      threadId: sessionId,
      config: { userName: "Latest" },
    });
  });

  function queueSuccessorDefaults(threadId: string) {
    RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
      mode: "explicit",
      draftModelSelection: null,
      inFlight: true,
      queued: { mode: "explicit", draftModelSelection: null },
    });
  }

  test("direct sends retain their payload and submission owner while successor defaults are deferred", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    queueSuccessorDefaults(threadId);
    const attachment = {
      filename: "queued.png",
      contentBase64: "aGVsbG8=",
      mimeType: "image/png",
    };
    const references = [{ kind: "skill" as const, name: "review" }];
    const draftSubmission = { key: `thread:${threadId}`, revision: 7, submissionId: "queued-send" };
    const clientMessageId = "queued-message";
    jsonRpcRequests.length = 0;

    const accepted = await useAppStore
      .getState()
      .sendMessage("Run after defaults", "reject", [attachment], references, {
        targetThreadId: threadId,
        draftSubmission,
        clientMessageId,
      });
    await flushAsyncWork();
    const sentWhileDeferred = requestsFor("turn/start").length;
    const queuedMessages = RUNTIME.pendingThreadMessages.get(threadId)?.slice();
    const queuedAttachments = RUNTIME.pendingThreadAttachments.get(threadId)?.slice();
    const queuedReferences = RUNTIME.pendingThreadReferences.get(threadId)?.slice();

    RUNTIME.pendingWorkspaceDefaultApplyByThread.set(threadId, {
      mode: "explicit",
      draftModelSelection: null,
      inFlight: false,
    });
    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    expect(accepted).toBe(true);
    expect(sentWhileDeferred).toBe(0);
    expect(queuedMessages).toEqual([
      { text: "Run after defaults", clientMessageId, draftSubmission },
    ]);
    expect(queuedAttachments).toEqual([[attachment]]);
    expect(queuedReferences).toEqual([references]);
    expect(latestRequest("turn/start")?.params).toMatchObject({
      threadId: sessionId,
      clientMessageId,
      input: [
        { type: "text", text: "Run after defaults" },
        { type: "file", ...attachment },
      ],
      references,
    });
  });

  for (const busy of [false, true]) {
    test(`tool retry sends are not accepted into the lossy pending queue while defaults are deferred (busy=${busy})`, async () => {
      primeWorkspaceConnection();
      const { threadId } = seedConnectedThread({ busy });
      queueSuccessorDefaults(threadId);
      jsonRpcRequests.length = 0;

      const accepted = await useAppStore
        .getState()
        .sendMessage("Retry the tool", "queue", undefined, undefined, {
          targetThreadId: threadId,
          clientMessageId: "retry-message",
          retryToolItemIds: ["failed-tool"],
        });
      await flushAsyncWork();

      expect(accepted).toBe(false);
      expect(RUNTIME.pendingThreadMessages.has(threadId)).toBe(false);
      expect(requestsFor("turn/start")).toHaveLength(0);
    });
  }

  test("deferred successor defaults do not queue a steer for an already-running turn", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread({ busy: true });
    useAppStore.setState((state) => ({
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: { ...state.threadRuntimeById[threadId], activeTurnId: "active-turn" },
      },
    }));
    queueSuccessorDefaults(threadId);
    jsonRpcResponseOverrides.set("turn/steer", async () => ({
      turnId: "active-turn",
      steerRequestId: "accepted-steer",
    }));
    jsonRpcRequests.length = 0;

    const accepted = await useAppStore
      .getState()
      .sendMessage("Adjust the current turn", "steer", undefined, undefined, {
        targetThreadId: threadId,
        clientMessageId: "steer-message",
      });
    await flushAsyncWork();

    expect(accepted).toBe(true);
    expect(RUNTIME.pendingThreadMessages.has(threadId)).toBe(false);
    expect(requestsFor("turn/start")).toHaveLength(0);
    expect(latestRequest("turn/steer")?.params).toMatchObject({
      threadId: sessionId,
      turnId: "active-turn",
      clientMessageId: "steer-message",
    });
  });

  test("applyWorkspaceDefaultsToThread flushes the oldest queued message after defaults apply", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    RUNTIME.pendingThreadMessages.set(threadId, [
      { text: "first queued" },
      { text: "second queued" },
    ]);
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    expect(requestsFor("turn/start")).toHaveLength(1);
    expect(latestRequest("turn/start")?.params).toMatchObject({
      threadId: sessionId,
      input: [{ type: "text", text: "first queued" }],
    });
    expect(RUNTIME.pendingThreadMessages.get(threadId)).toEqual([{ text: "second queued" }]);
  });

  test("applyWorkspaceDefaultsToThread flushes queued attachment-only sends after defaults apply", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    const attachment = {
      filename: "queued.png",
      contentBase64: "aGVsbG8=",
      mimeType: "image/png",
    };
    RUNTIME.pendingThreadMessages.set(threadId, [{ text: "" }, { text: "second queued" }]);
    RUNTIME.pendingThreadAttachments.set(threadId, [[attachment], undefined]);
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    expect(requestsFor("turn/start")).toHaveLength(1);
    expect(latestRequest("turn/start")?.params).toMatchObject({
      threadId: sessionId,
      input: [{ type: "file", ...attachment }],
    });
    expect(RUNTIME.pendingThreadMessages.get(threadId)).toEqual([{ text: "second queued" }]);
    expect(RUNTIME.pendingThreadAttachments.get(threadId)).toEqual([undefined]);
  });

  test("applyWorkspaceDefaultsToThread does not persist a transcript entry when the request fails", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      throw new Error("boom");
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    transcriptBatches.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushAsyncWork();

    const appliedDefaultsEntries = transcriptBatches
      .flat()
      .filter(
        (entry) =>
          entry.direction === "client" &&
          typeof entry.payload === "object" &&
          entry.payload !== null &&
          (entry.payload as { type?: unknown }).type === "apply_session_defaults",
      );
    expect(appliedDefaultsEntries).toHaveLength(0);
    expect(useAppStore.getState().notifications.at(-1)?.detail).toBe(
      "Unable to apply workspace defaults to the active thread.",
    );
  });

  test("applyWorkspaceDefaultsToThread preserves a baseten workspace provider", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultProvider: "baseten",
              defaultModel: "moonshotai/Kimi-K2.5",
              defaultPreferredChildModel: "moonshotai/Kimi-K2.5",
            }
          : workspace,
      ),
    }));
    const { threadId } = seedConnectedThread();
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      provider: "baseten",
      model: "moonshotai/Kimi-K2.5",
    });
  });

  test("updateWorkspaceDefaults clears the persisted overflow override on the control session", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...(state as any),
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultToolOutputOverflowChars: 12000,
            }
          : workspace,
      ),
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlSessionConfig: {
            defaultToolOutputOverflowChars: 12000,
          },
          controlEnableMcp: true,
        },
      },
    }));
    const { sessionId } = seedConnectedThread({
      sessionConfig: {
        defaultToolOutputOverflowChars: 12000,
      },
    });
    setControlSessionConfigResponse({
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
      clearToolOutputOverflowChars: true,
    });
    jsonRpcResponseOverrides.set("cowork/session/state/read", async () => ({
      events: [
        {
          type: "config_updated",
          sessionId: "jsonrpc-control",
          config: {
            provider: "openai",
            model: "gpt-5.2",
            workingDirectory: "/tmp/workspace",
          },
        },
        {
          type: "session_settings",
          sessionId: "jsonrpc-control",
          enableMcp: true,
          enableMemory: true,
          memoryRequireApproval: false,
        },
        {
          type: "session_config",
          sessionId: "jsonrpc-control",
          config: {
            yolo: false,
            observabilityEnabled: false,
            backupsEnabled: true,
            defaultBackupsEnabled: true,
            defaultToolOutputOverflowChars: 12000,
            enableMemory: true,
            memoryRequireApproval: false,
            preferredChildModel: "gpt-5.2",
            childModelRoutingMode: "same-provider",
            preferredChildModelRef: "openai:gpt-5.2",
            allowedChildModelRefs: [],
            maxSteps: 100,
          },
        },
      ],
    }));
    jsonRpcRequests.length = 0;

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      clearDefaultToolOutputOverflowChars: true,
    });
    await flushAsyncWork();

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();
    const applyRequests = requestsFor("cowork/session/defaults/apply");
    // The control-session apply clears the workspace-level override, and the
    // settings fan-out clears the same override on the live thread session —
    // the connected thread is no longer pruned by the thread/list reconcile.
    expect(applyRequests).toHaveLength(2);
    expect(applyRequests[0]?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        clearToolOutputOverflowChars: true,
      },
    });
    expect(applyRequests[0]?.params).not.toHaveProperty("threadId");
    expect(applyRequests[1]?.params).toMatchObject({
      threadId: sessionId,
      cwd: "/tmp/workspace",
      config: {
        clearToolOutputOverflowChars: true,
      },
    });
  });

  test("applyWorkspaceDefaultsToThread syncs advanced memory defaults and clears stale model overrides", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultAdvancedMemory: true,
              defaultMemoryGenerationModel: undefined,
            }
          : workspace,
      ),
    }));
    const { threadId } = seedConnectedThread({
      sessionConfig: {
        advancedMemory: false,
        memoryGenerationModel: "gemini-old",
      },
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "explicit");
    await flushAsyncWork();

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        advancedMemory: true,
        clearMemoryGenerationModel: true,
      },
    });
  });

  test("applyWorkspaceDefaultsToThread preserves saved memory model when control config is partial", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultAdvancedMemory: true,
              defaultMemoryGenerationModel: "gemini-saved",
            }
          : workspace,
      ),
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlSessionConfig: {
            advancedMemory: true,
          },
          controlEnableMcp: true,
        },
      },
    }));
    const { threadId } = seedConnectedThread({
      sessionConfig: {
        advancedMemory: false,
        memoryGenerationModel: "gemini-old",
      },
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "explicit");
    await flushAsyncWork();

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        advancedMemory: true,
        memoryGenerationModel: "gemini-saved",
      },
    });
  });

  test("applyWorkspaceDefaultsToThread preserves live memory model when saved default is unset", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultAdvancedMemory: undefined,
              defaultMemoryGenerationModel: undefined,
            }
          : workspace,
      ),
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlSessionConfig: {
            advancedMemory: true,
            memoryGenerationModel: "gemini-live",
          },
          controlEnableMcp: true,
        },
      },
    }));
    const { threadId } = seedConnectedThread({
      sessionConfig: {
        advancedMemory: false,
        memoryGenerationModel: "gemini-old",
      },
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "explicit");
    await flushAsyncWork();

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        advancedMemory: true,
        memoryGenerationModel: "gemini-live",
      },
    });
  });

  test("updateWorkspaceDefaults syncs advanced memory defaults to the control session", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlSessionConfig: {
            advancedMemory: false,
          },
          controlEnableMcp: true,
        },
      },
    }));
    jsonRpcRequests.length = 0;

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultAdvancedMemory: true,
      defaultMemoryGenerationModel: "gemini-new",
    });
    await flushAsyncWork();

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        advancedMemory: true,
        memoryGenerationModel: "gemini-new",
      },
    });
  });

  test("updateWorkspaceDefaults keeps control runtime in sync after a workspace control apply", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...(state as any),
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionId: `jsonrpc:${workspaceId}`,
          controlConfig: {
            provider: "google",
            model: "gemini-3-pro",
            workingDirectory: "/tmp/workspace",
          },
          controlSessionConfig: {
            defaultBackupsEnabled: true,
          },
          controlEnableMcp: true,
        },
      },
    }));
    setControlSessionConfigResponse({
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
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultProvider: "openai",
      defaultModel: "gpt-5.2",
      defaultEnableMcp: false,
    });

    const runtimeAfterFirstApply = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(runtimeAfterFirstApply?.controlConfig).toEqual({
      provider: "openai",
      model: "gpt-5.2",
      workingDirectory: "/tmp/workspace",
    });
    expect(runtimeAfterFirstApply?.controlEnableMcp).toBe(false);

    jsonRpcRequests.length = 0;
    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {});

    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
  });
});
