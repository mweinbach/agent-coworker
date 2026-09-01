import { afterEach, describe, expect, test } from "bun:test";
import { __internalWorkspaceDefaults } from "../src/app/store.actions/workspaceDefaults";
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

async function waitForCondition(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const intervalMs = opts.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for test condition`);
    }
    await Bun.sleep(intervalMs);
  }
}

describe("workspace settings sync", () => {
  registerWorkspaceSettingsSyncLifecycleHooks();

  afterEach(() => {
    __internalWorkspaceDefaults.setControlSessionApplyTimeoutMsForTests(null);
    __internalWorkspaceDefaults.setDeferredControlSyncTimeoutMsForTests(null);
  });

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

  test("updateWorkspaceDefaults applies workflow concurrency to the running workspace", async () => {
    jsonRpcRequests.length = 0;

    const result = await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultWorkflowMaxConcurrentAgents: 3,
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId)
        ?.defaultWorkflowMaxConcurrentAgents,
    ).toBe(3);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      config: { workflowMaxConcurrentAgents: 3 },
    });
  });

  test("keeps the preferred subagent model and its ref together in one patch", async () => {
    // Reproduces a real workspace: the chat provider moved to codex-cli while a
    // Google subagent model stayed saved. Sending the legacy model id alone made
    // the server drop the ref, resolve "gemini-3.1-pro-preview" against
    // codex-cli, and reject every settings write with a validation error.
    useAppStore.setState((state) => ({
      ...state,
      workspaces: [
        {
          ...state.workspaces[0]!,
          defaultProvider: "codex-cli",
          defaultModel: "gpt-5.4",
          defaultPreferredChildModel: "gemini-3.1-pro-preview",
          defaultChildModelRoutingMode: "same-provider",
          defaultPreferredChildModelRef: "google:gemini-3.1-pro-preview",
          defaultAllowedChildModelRefs: [],
        },
      ],
    }));
    // The live session already reports the ref the workspace wants, so the ref
    // diff alone does not fire and only the legacy field would be patched.
    const liveSessionConfig = {
      yolo: false,
      preferredChildModel: "gpt-5.4",
      childModelRoutingMode: "same-provider",
      preferredChildModelRef: "google:gemini-3.1-pro-preview",
      allowedChildModelRefs: [],
    };
    jsonRpcResponseOverrides.set("cowork/session/state/read", async () => ({
      events: [
        {
          type: "config_updated",
          sessionId: "jsonrpc-control",
          config: { provider: "codex-cli", model: "gpt-5.4", workingDirectory: "/tmp/workspace" },
        },
        { type: "session_config", sessionId: "jsonrpc-control", config: liveSessionConfig },
      ],
    }));
    setControlSessionConfigResponse(liveSessionConfig);
    await requestJsonRpcControlEvent(
      useAppStore.getState,
      useAppStore.setState,
      workspaceId,
      "cowork/session/state/read",
      { cwd: "/tmp/workspace" },
    );
    jsonRpcRequests.length = 0;

    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultPreferredChildModel: "gemini-3.1-pro-preview",
    });

    const applied = latestRequest("cowork/session/defaults/apply")?.params as
      | { config?: Record<string, unknown> }
      | undefined;
    expect(applied?.config?.preferredChildModel).toBe("gemini-3.1-pro-preview");
    expect(applied?.config?.preferredChildModelRef).toBe("google:gemini-3.1-pro-preview");
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

    // The server's rejection reason is carried through instead of being replaced
    // by a generic message — that detail is the only actionable part.
    expect(result).toMatchObject({
      ok: false,
      error: {
        message: "Cowork could not apply these settings to the running workspace: boom",
        repairAction: "Retry, or restart the workspace if it keeps failing.",
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
    expect(notification?.detail).toContain("Retry, or restart the workspace");
  });

  test("consecutive workspace changes preserve and apply the latest user intent", async () => {
    const firstResponse = createDeferred<unknown>();
    let applyCount = 0;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async (params) => {
      applyCount += 1;
      if (applyCount === 1) return await firstResponse.promise;
      return {
        event: {
          type: "session_config",
          sessionId: "jsonrpc-control",
          config: { userName: (params as { config: { userName: string } }).config.userName },
        },
      };
    });

    const first = useAppStore
      .getState()
      .updateWorkspaceDefaults(workspaceId, { userName: "First" });
    await waitForCondition(() => applyCount === 1);
    const second = useAppStore
      .getState()
      .updateWorkspaceDefaults(workspaceId, { userName: "Latest" });
    firstResponse.resolve({
      event: {
        type: "session_config",
        sessionId: "jsonrpc-control",
        config: { userName: "First" },
      },
    });
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      config: { userName: "Latest" },
    });
    expect(
      useAppStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)?.userName,
    ).toBe("Latest");
  });

  test("failed defaults only roll back fields they own, preserving later workspace changes", async () => {
    const response = createDeferred<unknown>();
    let requested = false;
    const previousUserName = useAppStore.getState().workspaces[0]?.userName;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async () => {
      requested = true;
      return await response.promise;
    });
    const update = useAppStore
      .getState()
      .updateWorkspaceDefaults(workspaceId, { userName: "Rejected" });
    await waitForCondition(() => requested);
    useAppStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, name: "Renamed while saving" } : workspace,
      ),
    }));
    response.reject(new Error("Settings rejected"));

    expect((await update).ok).toBe(false);
    const workspace = useAppStore
      .getState()
      .workspaces.find((workspace) => workspace.id === workspaceId);
    expect(workspace?.name).toBe("Renamed while saving");
    expect(workspace?.userName).toBe(previousUserName);
  });

  test("workspace and global memory settings share the same acknowledged write order", async () => {
    const firstResponse = createDeferred<unknown>();
    let applyCount = 0;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async (params) => {
      applyCount += 1;
      if (applyCount === 1) return await firstResponse.promise;
      return {
        event: {
          type: "session_config",
          sessionId: "jsonrpc-control",
          config: {
            userName: "Saved name",
            ...(params as { config: Record<string, unknown> }).config,
          },
        },
      };
    });

    const defaults = useAppStore
      .getState()
      .updateWorkspaceDefaults(workspaceId, { userName: "Saved name" });
    await waitForCondition(() => applyCount === 1);
    const memory = useAppStore.getState().setWorkspaceAdvancedMemory(workspaceId, true);
    await flushAsyncWork();
    const requestsBeforeAcknowledgement = applyCount;
    firstResponse.resolve({
      event: {
        type: "session_config",
        sessionId: "jsonrpc-control",
        config: { userName: "Saved name" },
      },
    });
    const results = await Promise.all([defaults, memory]);

    expect(requestsBeforeAcknowledgement).toBe(1);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(
      useAppStore.getState().workspaces.find((workspace) => workspace.id === workspaceId),
    ).toMatchObject({ userName: "Saved name", defaultAdvancedMemory: true });
  });

  test("updateWorkspaceDefaults keeps the saved change when the control session is still connecting", async () => {
    // A control socket that never reaches ready is exactly the cold-start state
    // the desktop hit: settings were already persisted, so reporting a failure
    // and reverting the toggle was wrong.
    class NeverReadyJsonRpcSocket extends MockJsonRpcSocket {
      readonly readyPromise = Promise.reject(new Error("still connecting"));
      override connect() {}
    }
    // The rejection is consumed by waitForReady; keep Bun from flagging it early.
    setJsonRpcSocketOverride(NeverReadyJsonRpcSocket);
    RUNTIME.jsonRpcSockets.clear();
    __controlSocketInternal.reset();
    jsonRpcRequests.length = 0;
    useAppStore.setState((state) => ({ ...state, notifications: [] }));

    const result = await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultModel: "gpt-5.4",
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId)?.defaultModel,
    ).toBe("gpt-5.4");
    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);
    expect(
      useAppStore
        .getState()
        .notifications.filter((entry) => entry.title === "Workspace settings not updated"),
    ).toHaveLength(0);
  });

  test("updateWorkspaceDefaults catch-up applies defaults once the control session becomes ready", async () => {
    // Cold start: the first apply times out while the socket is still connecting,
    // then the deferred catch-up must push the latest persisted defaults.
    __internalWorkspaceDefaults.setControlSessionApplyTimeoutMsForTests(25);
    __internalWorkspaceDefaults.setDeferredControlSyncTimeoutMsForTests(2_000);

    const ready = createDeferred<void>();
    let openHandler: (() => void) | undefined;
    class LaterReadyJsonRpcSocket extends MockJsonRpcSocket {
      readonly readyPromise = ready.promise;
      override connect() {
        openHandler = () => this.opts.onOpen?.();
      }
      markReady() {
        ready.resolve();
        openHandler?.();
      }
    }

    setJsonRpcSocketOverride(LaterReadyJsonRpcSocket);
    RUNTIME.jsonRpcSockets.clear();
    __controlSocketInternal.reset();
    jsonRpcRequests.length = 0;
    useAppStore.setState((state) => ({ ...state, notifications: [] }));
    primeWorkspaceConnection();

    const result = await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultModel: "gpt-5.4",
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      useAppStore.getState().workspaces.find((entry) => entry.id === workspaceId)?.defaultModel,
    ).toBe("gpt-5.4");
    expect(requestsFor("cowork/session/defaults/apply")).toHaveLength(0);

    const socket = MockJsonRpcSocket.instances.at(-1) as LaterReadyJsonRpcSocket | undefined;
    expect(socket).toBeInstanceOf(LaterReadyJsonRpcSocket);
    socket?.markReady();

    await waitForCondition(() => requestsFor("cowork/session/defaults/apply").length === 1);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      cwd: "/tmp/workspace",
      model: "gpt-5.4",
    });
    expect(
      useAppStore
        .getState()
        .notifications.filter((entry) => entry.title === "Workspace settings not updated"),
    ).toHaveLength(0);
  });

  test("a later settings change waits for a deferred startup sync before applying", async () => {
    __internalWorkspaceDefaults.setControlSessionApplyTimeoutMsForTests(25);
    __internalWorkspaceDefaults.setDeferredControlSyncTimeoutMsForTests(2_000);
    const ready = createDeferred<void>();
    let openHandler: (() => void) | undefined;
    class LaterReadyJsonRpcSocket extends MockJsonRpcSocket {
      readonly readyPromise = ready.promise;
      override connect() {
        openHandler = () => this.opts.onOpen?.();
      }
      markReady() {
        ready.resolve();
        openHandler?.();
      }
    }

    setJsonRpcSocketOverride(LaterReadyJsonRpcSocket);
    RUNTIME.jsonRpcSockets.clear();
    __controlSocketInternal.reset();
    primeWorkspaceConnection();
    await useAppStore.getState().updateWorkspaceDefaults(workspaceId, {
      defaultModel: "gpt-5.4",
    });

    const firstResponse = createDeferred<unknown>();
    let applyCount = 0;
    jsonRpcResponseOverrides.set("cowork/session/defaults/apply", async (params) => {
      applyCount += 1;
      if (applyCount === 1) return await firstResponse.promise;
      return {
        event: {
          type: "config_updated",
          sessionId: "jsonrpc-control",
          config: {
            provider: "openai",
            model: (params as { model: string }).model,
            workingDirectory: "/tmp/workspace",
          },
        },
      };
    });
    (MockJsonRpcSocket.instances.at(-1) as LaterReadyJsonRpcSocket).markReady();
    await waitForCondition(() => applyCount === 1);

    let latestSettled = false;
    const latest = useAppStore
      .getState()
      .updateWorkspaceDefaults(workspaceId, { defaultModel: "gpt-5.2" })
      .then((result) => {
        latestSettled = true;
        return result;
      });
    await flushAsyncWork();
    const settledBeforeAcknowledgement = latestSettled;
    firstResponse.resolve({
      event: {
        type: "config_updated",
        sessionId: "jsonrpc-control",
        config: {
          provider: "openai",
          model: "gpt-5.4",
          workingDirectory: "/tmp/workspace",
        },
      },
    });
    const result = await latest;
    await flushAsyncWork();

    expect(settledBeforeAcknowledgement).toBe(false);
    expect(result.ok).toBe(true);
    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      model: "gpt-5.2",
    });
    expect(
      useAppStore.getState().workspaces.find((workspace) => workspace.id === workspaceId)
        ?.defaultModel,
    ).toBe("gpt-5.2");
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

  test("applyWorkspaceDefaultsToThread updates workflow concurrency for existing chats", async () => {
    primeWorkspaceConnection();
    useAppStore.setState((state) => ({
      ...state,
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, defaultWorkflowMaxConcurrentAgents: 3 }
          : workspace,
      ),
    }));
    const { threadId, sessionId } = seedConnectedThread({
      sessionConfig: { workflowMaxConcurrentAgents: 12 },
    });
    jsonRpcRequests.length = 0;

    await useAppStore.getState().applyWorkspaceDefaultsToThread(threadId);

    expect(latestRequest("cowork/session/defaults/apply")?.params).toMatchObject({
      threadId: sessionId,
      cwd: "/tmp/workspace",
      config: { workflowMaxConcurrentAgents: 3 },
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
