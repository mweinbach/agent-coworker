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

  test("control session_config hydrates the workspace defaults from the harness", async () => {
    primeWorkspaceConnection();
    setControlSessionConfigResponse({
      yolo: true,
      observabilityEnabled: true,
      backupsEnabled: false,
      defaultBackupsEnabled: false,
      toolOutputOverflowChars: 12000,
      defaultToolOutputOverflowChars: 12000,
      preferredChildModel: "gpt-5-mini",
      childModelRoutingMode: "cross-provider-allowlist",
      preferredChildModelRef: "opencode-zen:glm-5",
      allowedChildModelRefs: ["opencode-zen:glm-5", "opencode-go:glm-5"],
      maxSteps: 75,
      userName: "Alex",
      userProfile: { instructions: "", work: "", details: "" },
    });

    const ok = await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.yolo).toBe(true);
    expect(workspace?.defaultPreferredChildModel).toBe("gpt-5-mini");
    expect(workspace?.defaultChildModelRoutingMode).toBe("cross-provider-allowlist");
    expect(workspace?.defaultPreferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(workspace?.defaultAllowedChildModelRefs).toEqual([
      "opencode-zen:glm-5",
      "opencode-go:glm-5",
    ]);
    expect(workspace?.defaultBackupsEnabled).toBe(false);
    expect(workspace?.defaultToolOutputOverflowChars).toBe(12000);
    expect(workspace?.userName).toBe("Alex");
    expect(workspace?.userProfile).toEqual({ instructions: "", work: "", details: "" });
    expect(runtime?.controlSessionConfig?.yolo).toBe(true);
    expect(runtime?.controlSessionConfig?.preferredChildModel).toBe("gpt-5-mini");
    expect(runtime?.controlSessionConfig?.childModelRoutingMode).toBe("cross-provider-allowlist");
    expect(runtime?.controlSessionConfig?.preferredChildModelRef).toBe("opencode-zen:glm-5");
    expect(runtime?.controlSessionConfig?.allowedChildModelRefs).toEqual([
      "opencode-zen:glm-5",
      "opencode-go:glm-5",
    ]);
    expect(runtime?.controlSessionConfig?.backupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultBackupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultToolOutputOverflowChars).toBe(12000);
  });

  test("control session_config keeps session backup overrides separate from the workspace default", async () => {
    primeWorkspaceConnection();
    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: false,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      maxSteps: 75,
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.defaultBackupsEnabled).toBe(true);
    expect(workspace?.defaultToolOutputOverflowChars).toBeUndefined();
    expect(runtime?.controlSessionConfig?.backupsEnabled).toBe(false);
    expect(runtime?.controlSessionConfig?.defaultBackupsEnabled).toBe(true);
    expect(runtime?.controlSessionConfig?.toolOutputOverflowChars).toBe(25000);
  });

  test("control session_config replaces editable providerOptions in workspace defaults", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              providerOptions: {
                openai: {
                  reasoningEffort: "high",
                  reasoningSummary: "detailed",
                },
              },
            }
          : workspace,
      ),
    }));

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: true,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      providerOptions: {
        openai: {
          reasoningSummary: "concise",
          textVerbosity: "high",
        },
        "codex-cli": {
          reasoningEffort: "xhigh",
          reasoningSummary: "auto",
          webSearchBackend: "native",
          webSearchMode: "live",
        },
      },
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toEqual({
      openai: {
        reasoningSummary: "concise",
        textVerbosity: "high",
      },
      "codex-cli": {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        webSearchBackend: "native",
        webSearchMode: "live",
      },
    });
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toEqual({
      openai: {
        reasoningSummary: "concise",
        textVerbosity: "high",
      },
      "codex-cli": {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        webSearchBackend: "native",
        webSearchMode: "live",
      },
    });
  });

  test("control session_config preserves saved providerOptions when snapshot omits them", async () => {
    primeWorkspaceConnection();
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
                },
                google: {
                  nativeWebSearch: false,
                },
              },
            }
          : workspace,
      ),
    }));

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: true,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      maxSteps: 75,
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toEqual({
      "codex-cli": {
        webSearchBackend: "parallel",
        webSearchFallbackBackend: "parallel",
      },
      google: {
        nativeWebSearch: false,
      },
    });
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toBeUndefined();
  });

  test("control session_config preserves saved search settings when providerOptions are partial", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              providerOptions: {
                "codex-cli": {
                  reasoningEffort: "high",
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
    }));

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: true,
      defaultBackupsEnabled: true,
      toolOutputOverflowChars: 25000,
      preferredChildModel: "gpt-5-mini",
      providerOptions: {
        "codex-cli": {
          reasoningSummary: "detailed",
          textVerbosity: "medium",
        },
        google: {
          responseMimeType: "application/json",
        },
      },
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    const runtime = useAppStore.getState().workspaceRuntimeById[workspaceId];
    expect(workspace?.providerOptions).toEqual({
      "codex-cli": {
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
    });
    expect((runtime?.controlSessionConfig as any)?.providerOptions).toEqual({
      "codex-cli": {
        reasoningSummary: "detailed",
        textVerbosity: "medium",
      },
      google: {
        responseMimeType: "application/json",
      },
    });
  });

  test("control session_config preserves saved routing defaults when snapshot omits them", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? {
              ...workspace,
              defaultBackupsEnabled: false,
              defaultPreferredChildModel: "claude-opus-4-8",
              defaultChildModelRoutingMode: "cross-provider-allowlist",
              defaultPreferredChildModelRef: "anthropic:claude-opus-4-8",
              defaultAllowedChildModelRefs: ["anthropic:claude-opus-4-8", "openai:gpt-5.4"],
            }
          : workspace,
      ),
    }));

    setControlSessionConfigResponse({
      yolo: false,
      observabilityEnabled: true,
      backupsEnabled: true,
      toolOutputOverflowChars: 25000,
      maxSteps: 75,
    });

    await requestJsonRpcControlEvent(
      useAppStore.getState as any,
      useAppStore.setState as any,
      workspaceId,
      "cowork/session/defaults/apply",
      { cwd: "/tmp/workspace" },
    );

    const workspace = useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId);
    expect(workspace?.defaultBackupsEnabled).toBe(false);
    expect(workspace?.defaultPreferredChildModel).toBe("claude-opus-4-8");
    expect(workspace?.defaultChildModelRoutingMode).toBe("cross-provider-allowlist");
    expect(workspace?.defaultPreferredChildModelRef).toBe("anthropic:claude-opus-4-8");
    expect(workspace?.defaultAllowedChildModelRefs).toEqual([
      "anthropic:claude-opus-4-8",
      "openai:gpt-5.4",
    ]);
  });
});
