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

  test("updateWorkspaceDefaults syncs control defaults over the shared JsonRpcSocket", async () => {
    jsonRpcRequests.length = 0;
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
      userName: "Taylor",
      userProfile: {
        instructions: "Keep answers terse.",
        work: "Platform engineer",
        details: "Prefers Bun and TypeScript",
      },
      featureFlags: {
        workspace: {
          a2ui: false,
        },
      },
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      },
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      userName: "Taylor",
      userProfile: {
        instructions: "Keep answers terse.",
        work: "Platform engineer",
        details: "Prefers Bun and TypeScript",
      },
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "detailed",
        },
      },
    });

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.userName).toBe("Taylor");
    expect(workspace?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun and TypeScript",
    });

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        userName: "Taylor",
        userProfile: {
          instructions: "Keep answers terse.",
          work: "Platform engineer",
          details: "Prefers Bun and TypeScript",
        },
        providerOptions: {
          "codex-cli": {
            reasoningEffort: "xhigh",
            reasoningSummary: "detailed",
          },
        },
      },
    });
    expect(useAppStore.getState().notifications).toHaveLength(0);
  });

  test("updateWorkspaceDefaults reports partial apply when the control request fails", async () => {
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      throw new Error("boom");
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    });

    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification?.title).toBe("Workspace settings partially applied");
    expect(notification?.detail).toBe(
      "Control session is not fully connected yet. Reopen the workspace settings to retry.",
    );
  });

  test("updateWorkspaceDefaults updates yolo configuration dynamically", async () => {
    jsonRpcRequests.length = 0;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async (params: any) => ({
      event: {
        type: "session_config",
        sessionId: "jsonrpc-control",
        config: {
          yolo: params?.config?.yolo ?? false,
          observabilityEnabled: false,
          backupsEnabled: true,
          defaultBackupsEnabled: true,
          preferredChildModel: "gpt-5.2",
          childModelRoutingMode: "same-provider",
          preferredChildModelRef: "openai:gpt-5.2",
          allowedChildModelRefs: [],
          maxSteps: 100,
          toolOutputOverflowChars: 25000,
        },
      },
    }));

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, { yolo: true });

    let workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.yolo).toBe(true);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: { yolo: true },
    });

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, { yolo: false });

    workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.yolo).toBe(false);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: { yolo: false },
    });
  });

  test("applyWorkspaceDefaultsToThread routes thread defaults over the shared JsonRpcSocket", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultChildModelRoutingMode: "cross-provider-allowlist",
              defaultPreferredChildModelRef: "opencode-zen:glm-5",
              defaultAllowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
              userName: "Alex",
              userProfile: {
                instructions: "Keep answers terse.",
                work: "Platform engineer",
                details: "Prefers Bun",
              },
              providerOptions: {
                openai: {
                  reasoningEffort: "high",
                  reasoningSummary: "detailed",
                  textVerbosity: "medium",
                },
              },
              yolo: true,
            }
          : workspace,
      ),
    }));
    const { threadId } = seedConnectedThread();
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        toolOutputOverflowChars: 25000,
        yolo: true,
        childModelRoutingMode: "cross-provider-allowlist",
        preferredChildModelRef: "opencode-zen:glm-5",
        allowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
        userName: "Alex",
        userProfile: {
          instructions: "Keep answers terse.",
          work: "Platform engineer",
          details: "Prefers Bun",
        },
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "detailed",
            textVerbosity: "medium",
          },
        },
      },
    });
  });

  test("applyWorkspaceDefaultsToThread applies response-envelope thread state when no notification arrives", async () => {
    primeWorkspaceConnection();
    const { threadId, sessionId } = seedConnectedThread();
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => ({
      events: [
        {
          type: "config_updated",
          sessionId,
          config: {
            provider: "google",
            model: "gemini-3-pro",
            workingDirectory: "/tmp/workspace",
            outputDirectory: "/tmp/workspace/output",
          },
        },
        {
          type: "session_settings",
          sessionId,
          enableMcp: false,
          enableMemory: true,
          memoryRequireApproval: false,
        },
        {
          type: "session_config",
          sessionId,
          config: {
            yolo: false,
            observabilityEnabled: false,
            backupsEnabled: true,
            defaultBackupsEnabled: true,
            enableMemory: true,
            memoryRequireApproval: false,
            preferredChildModel: "gemini-3-pro",
            childModelRoutingMode: "same-provider",
            preferredChildModelRef: "google:gemini-3-pro",
            allowedChildModelRefs: [],
            maxSteps: 100,
            toolOutputOverflowChars: 32000,
          },
        },
      ],
    }));

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);
    await flushAsyncWork();

    const runtime = useAppStore.getState().threadRuntimeById[threadId];
    expect(runtime.config).toMatchObject({
      provider: "google",
      model: "gemini-3-pro",
    });
    expect(runtime.enableMcp).toBe(false);
    expect(runtime.sessionConfig).toMatchObject({
      preferredChildModel: "gemini-3-pro",
      preferredChildModelRef: "google:gemini-3-pro",
      toolOutputOverflowChars: 32000,
    });
  });

  test("applyWorkspaceDefaultsToThread preserves allowBeforeHydration when deferring for a busy thread", async () => {
    primeWorkspaceConnection();
    const { threadId } = seedConnectedThread();
    useAppStore.setState((state) => ({
      ...state,
      threadRuntimeById: {
        ...state.threadRuntimeById,
        [threadId]: {
          ...state.threadRuntimeById[threadId],
          sessionConfig: null,
          enableMcp: null,
          busy: true,
        },
      },
    }));
    jsonRpcRequests.length = 0;

    await useAppStore
      .getState()
      .applyWorkspaceDefaultsToThread(threadId, "auto", null, { allowBeforeHydration: true });

    expect(RUNTIME.pendingWorkspaceDefaultApplyByThread.get(threadId)?.allowBeforeHydration).toBe(
      true,
    );
    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
  });
});
