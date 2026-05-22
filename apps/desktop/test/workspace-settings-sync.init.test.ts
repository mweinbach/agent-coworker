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

  test("init normalizes workspace defaultPreferredChildModel fallback", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-load",
          name: "Loaded",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.defaultModel).toBe("gpt-5.2");
    expect(loaded?.defaultPreferredChildModel).toBe("gpt-5.2");
  });

  test("init migrates legacy defaultSubAgentModel into defaultPreferredChildModel", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-migrate",
          name: "Legacy migration",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultSubAgentModel: "gpt-5.2-mini",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.defaultModel).toBe("gpt-5.4");
    expect(loaded?.defaultPreferredChildModel).toBe("gpt-5.2-mini");
  });

  test("init preserves workspace user profile defaults during rehydration", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-profile",
          name: "Loaded profile",
          path: "/tmp/workspace-profile",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          userName: "Alex",
          userProfile: {
            instructions: "Keep answers terse.",
            work: "Platform engineer",
            details: "Prefers Bun",
          },
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    await useAppStore.getState().init();

    const loaded = useAppStore.getState().workspaces[0];
    expect(loaded?.userName).toBe("Alex");
    expect(loaded?.userProfile).toEqual({
      instructions: "Keep answers terse.",
      work: "Platform engineer",
      details: "Prefers Bun",
    });
  });

  test("init preserves persisted workspace overflow defaults during rehydration", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-null",
          name: "Null overflow",
          path: "/tmp/workspace-null",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultToolOutputOverflowChars: null,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws-default",
          name: "Default overflow",
          path: "/tmp/workspace-default",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:01.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultToolOutputOverflowChars: 25000,
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
        {
          id: "ws-missing",
          name: "Missing overflow",
          path: "/tmp/workspace-missing",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:02.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          defaultBackupsEnabled: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
    });

    await useAppStore.getState().init();

    const workspaces = useAppStore.getState().workspaces;
    expect(
      workspaces.find((workspace) => workspace.id === "ws-null")?.defaultToolOutputOverflowChars,
    ).toBeNull();
    expect(
      workspaces.find((workspace) => workspace.id === "ws-default")?.defaultToolOutputOverflowChars,
    ).toBe(25000);
    expect(
      workspaces.find((workspace) => workspace.id === "ws-missing")?.defaultToolOutputOverflowChars,
    ).toBeUndefined();
  });

  test("init hydrates persisted provider status snapshots before the first refresh completes", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-load",
          name: "Loaded",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [],
      developerMode: false,
      showHiddenFiles: false,
      providerState: {
        statusByName: {
          "codex-cli": {
            provider: "codex-cli",
            authorized: true,
            verified: false,
            mode: "oauth",
            account: { email: "max@example.com" },
            message: "Codex credentials present.",
            checkedAt: "2026-02-19T00:00:00.000Z",
          },
        },
        statusLastUpdatedAt: "2026-02-19T00:00:00.000Z",
      },
    });

    await useAppStore.getState().init();

    const state = useAppStore.getState();
    expect(state.providerStatusByName["codex-cli"]?.authorized).toBe(true);
    expect(state.providerStatusByName["codex-cli"]?.mode).toBe("oauth");
    expect(state.providerStatusByName["codex-cli"]?.account?.email).toBe("max@example.com");
    expect(state.providerStatusLastUpdatedAt).toBe("2026-02-19T00:00:00.000Z");
    expect(state.providerConnected).toEqual(["codex-cli"]);
  });

  test("init reopens the latest workspace thread even when it was persisted disconnected", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-load",
          name: "Loaded",
          path: "/tmp/workspace",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-load",
          workspaceId: "ws-load",
          title: "Recovered thread",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastMessageAt: "2026-02-19T00:05:00.000Z",
          status: "disconnected",
          sessionId: "thread-session-persisted",
        },
      ],
      developerMode: false,
      showHiddenFiles: false,
    });

    await useAppStore.getState().init();
    await flushAsyncWork();
    await flushAsyncWork();

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-load");
    expect(state.selectedThreadId).toBe("thread-session-persisted");
    expect(RUNTIME.jsonRpcSockets.has("ws-load")).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
  });

  test("init prefers the most recently opened workspace when restoring a thread", async () => {
    setMockedLoadedState({
      version: 2,
      workspaces: [
        {
          id: "ws-old",
          name: "Older",
          path: "/tmp/workspace-old",
          createdAt: "2026-02-18T00:00:00.000Z",
          lastOpenedAt: "2026-02-18T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
        {
          id: "ws-new",
          name: "Newer",
          path: "/tmp/workspace-new",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastOpenedAt: "2026-02-19T00:00:00.000Z",
          defaultProvider: "openai",
          defaultModel: "gpt-5.2",
          defaultEnableMcp: true,
          yolo: false,
        },
      ],
      threads: [
        {
          id: "thread-old",
          workspaceId: "ws-old",
          title: "Older thread",
          createdAt: "2026-02-18T00:00:00.000Z",
          lastMessageAt: "2026-02-18T00:05:00.000Z",
          status: "active",
          sessionId: "thread-session-old",
        },
        {
          id: "thread-new",
          workspaceId: "ws-new",
          title: "Newer thread",
          createdAt: "2026-02-19T00:00:00.000Z",
          lastMessageAt: "2026-02-19T00:05:00.000Z",
          status: "disconnected",
          sessionId: "thread-session-new",
        },
      ],
      developerMode: false,
      showHiddenFiles: false,
    });

    await useAppStore.getState().init();
    await flushAsyncWork();
    await flushAsyncWork();

    const state = useAppStore.getState();
    expect(state.selectedWorkspaceId).toBe("ws-new");
    expect(state.selectedThreadId).toBe("thread-session-new");
    expect(RUNTIME.jsonRpcSockets.has("ws-new")).toBe(true);
    expect(MockJsonRpcSocket.instances).toHaveLength(1);
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/read");
    expect(jsonRpcRequests.map((entry) => entry.method)).toContain("thread/resume");
  });
});
