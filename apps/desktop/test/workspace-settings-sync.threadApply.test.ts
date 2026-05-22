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

  test("applyWorkspaceDefaultsToThread flushes the oldest queued message after defaults apply", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    RUNTIME.pendingThreadMessages.set(threadId, ["first queued", "second queued"]);
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    expect(requestsFor("turn/start")).toHaveLength(1);
    expect(latestRequest("turn/start")?.params).toMatchObject({
      threadId: sessionId,
      input: [{ type: "text", text: "first queued" }],
    });
    expect(RUNTIME.pendingThreadMessages.get(threadId)).toEqual(["second queued"]);
  });

  test("applyWorkspaceDefaultsToThread flushes queued attachment-only sends after defaults apply", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    const attachment = {
      filename: "queued.png",
      contentBase64: "aGVsbG8=",
      mimeType: "image/png",
    };
    RUNTIME.pendingThreadMessages.set(threadId, ["", "second queued"]);
    RUNTIME.pendingThreadAttachments.set(threadId, [[attachment], undefined]);
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    expect(requestsFor("turn/start")).toHaveLength(1);
    expect(latestRequest("turn/start")?.params).toMatchObject({
      threadId: sessionId,
      input: [{ type: "file", ...attachment }],
    });
    expect(RUNTIME.pendingThreadMessages.get(threadId)).toEqual(["second queued"]);
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
    seedConnectedThread({
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
    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(1);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        clearToolOutputOverflowChars: true,
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
