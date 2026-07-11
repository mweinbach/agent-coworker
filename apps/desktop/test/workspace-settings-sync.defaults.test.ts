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
          REMOVEDUI: false,
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

  test("shared workspace defaults copy the complete settings shape into one-off chats", async () => {
    useAppStore.setState((state) => ({
      ...state,
      perWorkspaceSettings: false,
      selectedWorkspaceId: "chat-1",
      workspaces: [
        {
          ...state.workspaces[0]!,
          workspaceKind: "project",
          defaultProvider: "google",
          defaultModel: "gemini-3-flash-preview",
          defaultPreferredChildModel: "gemini-3-flash-preview",
          defaultChildModelRoutingMode: "same-provider",
          defaultPreferredChildModelRef: "google:gemini-3-flash-preview",
          defaultAllowedChildModelRefs: [],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          providerOptions: {
            google: { nativeWebSearch: true },
          },
          userName: "Project user",
          userProfile: {
            instructions: "Project-only instructions",
            work: "Project work",
            details: "Project details",
          },
          yolo: false,
        },
        {
          id: "chat-1",
          name: "One-off chat",
          path: "/tmp/one-off-chat",
          workspaceKind: "oneOffChat",
          createdAt: "2026-06-02T00:00:00.000Z",
          lastOpenedAt: "2026-06-02T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultProvider: "google",
          defaultModel: "ajax",
          defaultPreferredChildModel: "ajax",
          defaultChildModelRoutingMode: "same-provider",
          defaultPreferredChildModelRef: "google:ajax",
          defaultAllowedChildModelRefs: ["google:ajax"],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          providerOptions: {
            google: { nativeWebSearch: false },
          },
          userName: "Chat user",
          userProfile: {
            instructions: "Chat-only instructions",
            work: "Chat work",
            details: "Chat details",
          },
          yolo: false,
        },
      ],
    }));

    await useAppStore.getState().updateWorkspaceDefaults("chat-1", {
      defaultProvider: "codex-cli",
      defaultModel: "gpt-5.4",
      defaultPreferredChildModel: "gpt-5.4",
      defaultPreferredChildModelRef: "codex-cli:gpt-5.4",
      defaultAllowedChildModelRefs: ["codex-cli:gpt-5.4"],
      defaultEnableMcp: false,
      defaultBackupsEnabled: false,
      providerOptions: {
        "codex-cli": {
          webSearchBackend: "native",
          webSearchFallbackBackend: "parallel",
          webSearchMode: "live",
        },
      },
      userName: "Shared user",
      userProfile: {
        instructions: "Shared instructions",
        work: "Shared work",
        details: "Shared details",
      },
      yolo: true,
    });

    const state = useAppStore.getState();
    const project = state.workspaces.find((entry) => entry.id === workspaceId);
    const oneOff = state.workspaces.find((entry) => entry.id === "chat-1");
    expect(project?.defaultProvider).toBe("codex-cli");
    expect(oneOff?.defaultProvider).toBe("codex-cli");
    expect(oneOff?.defaultModel).toBe("gpt-5.4");
    expect(oneOff?.defaultAllowedChildModelRefs).toEqual(["codex-cli:gpt-5.4"]);
    expect(oneOff?.defaultEnableMcp).toBe(false);
    expect(oneOff?.defaultBackupsEnabled).toBe(false);
    expect(oneOff?.yolo).toBe(true);
    expect(oneOff?.providerOptions).toEqual(project?.providerOptions);
    expect(oneOff?.userName).toBe("Shared user");
    expect(oneOff?.userProfile).toEqual({
      instructions: "Shared instructions",
      work: "Shared work",
      details: "Shared details",
    });
  });

  test("target-scoped profile updates do not fan out when shared settings are enabled", async () => {
    useAppStore.setState((state) => ({
      ...state,
      perWorkspaceSettings: false,
      selectedWorkspaceId: workspaceId,
      workspaces: [
        {
          ...state.workspaces[0]!,
          workspaceKind: "project",
          userName: "Project user",
          userProfile: {
            instructions: "Project instructions",
            work: "Project work",
            details: "Project details",
          },
        },
        {
          id: "project-2",
          name: "Second project",
          path: "/tmp/second-project",
          workspaceKind: "project",
          createdAt: "2026-06-02T00:00:00.000Z",
          lastOpenedAt: "2026-06-02T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultProvider: "google",
          defaultModel: "gemini-3-flash-preview",
          defaultPreferredChildModel: "gemini-3-flash-preview",
          defaultChildModelRoutingMode: "same-provider",
          defaultPreferredChildModelRef: "google:gemini-3-flash-preview",
          defaultAllowedChildModelRefs: [],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          userName: "Second user",
          userProfile: {
            instructions: "Second instructions",
            work: "Second work",
            details: "Second details",
          },
          yolo: false,
        },
      ],
    }));

    await useAppStore.getState().updateWorkspaceDefaults(
      workspaceId,
      {
        userName: "Target user",
        userProfile: {
          instructions: "Target instructions",
          work: "Target work",
          details: "Target details",
        },
      },
      { scope: "target" },
    );

    const state = useAppStore.getState();
    const target = state.workspaces.find((entry) => entry.id === workspaceId);
    const other = state.workspaces.find((entry) => entry.id === "project-2");
    expect(target?.userName).toBe("Target user");
    expect(target?.userProfile).toEqual({
      instructions: "Target instructions",
      work: "Target work",
      details: "Target details",
    });
    expect(other?.userName).toBe("Second user");
    expect(other?.userProfile).toEqual({
      instructions: "Second instructions",
      work: "Second work",
      details: "Second details",
    });
  });

  test("per-target workspace defaults update grouped one-off chats", async () => {
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async (params: any) => ({
      event: {
        type: "session_config",
        sessionId: "jsonrpc-control",
        config: {
          yolo: params?.config?.yolo ?? false,
          defaultBackupsEnabled: params?.config?.backupsEnabled ?? true,
          preferredChildModel: "ajax-custom",
          childModelRoutingMode: "same-provider",
          preferredChildModelRef: "google:ajax-custom",
          allowedChildModelRefs: [],
          toolOutputOverflowChars: 25000,
        },
      },
    }));

    useAppStore.setState((state) => ({
      ...state,
      perWorkspaceSettings: true,
      selectedWorkspaceId: "chat-1",
      workspaces: [
        {
          ...state.workspaces[0]!,
          workspaceKind: "project",
          defaultModel: "gpt-5.2",
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "chat-1",
          name: "One-off chat",
          path: "/tmp/one-off-chat",
          workspaceKind: "oneOffChat",
          createdAt: "2026-06-02T00:00:00.000Z",
          lastOpenedAt: "2026-06-02T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultProvider: "google",
          defaultModel: "ajax",
          defaultPreferredChildModel: "ajax",
          defaultChildModelRoutingMode: "same-provider",
          defaultPreferredChildModelRef: "google:ajax",
          defaultAllowedChildModelRefs: [],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "chat-2",
          name: "One-off chat",
          path: "/tmp/one-off-chat-2",
          workspaceKind: "oneOffChat",
          createdAt: "2026-06-02T00:00:00.000Z",
          lastOpenedAt: "2026-06-02T00:00:00.000Z",
          wsProtocol: "jsonrpc",
          defaultProvider: "google",
          defaultModel: "ajax-two",
          defaultPreferredChildModel: "ajax-two",
          defaultChildModelRoutingMode: "same-provider",
          defaultPreferredChildModelRef: "google:ajax-two",
          defaultAllowedChildModelRefs: [],
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
    }));

    await useAppStore.getState().updateWorkspaceDefaults("chat-1", {
      defaultModel: "ajax-custom",
      defaultBackupsEnabled: false,
      yolo: true,
    });

    const state = useAppStore.getState();
    const project = state.workspaces.find((entry) => entry.id === workspaceId);
    const oneOff = state.workspaces.find((entry) => entry.id === "chat-1");
    const otherOneOff = state.workspaces.find((entry) => entry.id === "chat-2");
    expect(project?.defaultModel).toBe("gpt-5.2");
    expect(project?.defaultBackupsEnabled).toBe(true);
    expect(project?.yolo).toBe(false);
    expect(oneOff?.defaultModel).toBe("ajax-custom");
    expect(oneOff?.defaultBackupsEnabled).toBe(false);
    expect(oneOff?.yolo).toBe(true);
    expect(otherOneOff?.defaultModel).toBe("ajax-custom");
    expect(otherOneOff?.defaultBackupsEnabled).toBe(false);
    expect(otherOneOff?.yolo).toBe(true);
  });

  test("updateWorkspaceDefaults rolls back and returns an acknowledged failure", async () => {
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      throw new Error("boom");
    });
    const previousProviderOptions = useAppStore
      .getState()
      .workspaces.find((entry) => entry.id === workspaceId)?.providerOptions;

    const result = await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      providerOptions: {
        "codex-cli": {
          reasoningEffort: "xhigh",
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "Control session is not fully connected yet.",
        repairAction: "Wait for the workspace connection to finish, then retry.",
      },
    });
    expect(
      useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId)?.providerOptions,
    ).toEqual(previousProviderOptions);
    const notification = useAppStore.getState().notifications.at(-1);
    expect(notification).toMatchObject({
      title: "Workspace settings not updated",
      audience: "foreground",
    });
    expect(notification?.detail).toContain("Wait for the workspace connection to finish");
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

  test("applyWorkspaceDefaultsToThread restores saved search provider when live providerOptions are partial", async () => {
    primeWorkspaceConnection();
    const partialProviderOptions = {
      "codex-cli": {
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        textVerbosity: "medium",
      },
      google: {
        responseMimeType: "application/json",
      },
    };
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              providerOptions: {
                "codex-cli": {
                  webSearchBackend: "parallel",
                  webSearchFallbackBackend: "parallel",
                  webSearchMode: "live",
                },
                google: {
                  nativeWebSearch: false,
                },
              },
            }
          : workspace,
      ),
      workspaceRuntimeById: {
        ...state.workspaceRuntimeById,
        [workspaceId]: {
          ...state.workspaceRuntimeById[workspaceId],
          controlSessionConfig: {
            yolo: false,
            defaultBackupsEnabled: true,
            preferredChildModel: "gpt-5.2",
            childModelRoutingMode: "same-provider",
            preferredChildModelRef: "openai:gpt-5.2",
            allowedChildModelRefs: [],
            providerOptions: partialProviderOptions,
          },
          controlEnableMcp: true,
        },
      },
    }));
    const { threadId } = seedConnectedThread({
      sessionConfig: {
        providerOptions: partialProviderOptions,
      },
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId, "auto");

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: {
        providerOptions: {
          "codex-cli": {
            reasoningEffort: "high",
            reasoningSummary: "detailed",
            textVerbosity: "medium",
            webSearchBackend: "parallel",
            webSearchFallbackBackend: "parallel",
            webSearchMode: "live",
          },
          google: {
            nativeWebSearch: false,
            responseMimeType: "application/json",
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
