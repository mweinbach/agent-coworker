import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { PersistedState } from "../src/app/types";
import { createDesktopCommandsMock } from "./helpers/mockDesktopCommands";

const deleteTranscriptCalls: string[] = [];
const jsonRpcRequests: Array<{ method: string; params?: Record<string, unknown> }> = [];
const callOrder: string[] = [];
const savedStates: PersistedState[] = [];
const startWorkspaceServerCalls: string[] = [];
const workspaceStatusCalls: string[] = [];
const rpcReadyStates: boolean[] = [];
let serverStatusRunning = true;

const originalDateNow = Date.now;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

const storage = new Map<string, string>();
const localStorageMock = {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
};

function installWindowMock() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: localStorageMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "" }, localStorage: localStorageMock },
  });
}

class MockJsonRpcSocket {
  readonly readyPromise = Promise.resolve();

  connect() {}

  async request(method: string, params?: Record<string, unknown>) {
    jsonRpcRequests.push({ method, params });
    if (method === "cowork/session/delete") {
      rpcReadyStates.push(useAppStore.getState().ready);
      callOrder.push(`rpc:${String(params?.targetSessionId ?? "")}`);
      return {
        events: [
          {
            type: "session_deleted",
            sessionId: "control-session",
            targetSessionId: params?.targetSessionId,
          },
        ],
      };
    }
    return { events: [] };
  }

  respond() {
    return true;
  }

  close() {}
}

const persistedState: PersistedState = {
  version: 2,
  workspaces: [
    {
      id: "workspace-1",
      name: "Workspace",
      path: "/tmp/archived-session-auto-delete",
      workspaceKind: "project",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-20T00:00:00.000Z",
      wsProtocol: "jsonrpc",
      defaultProvider: "openai",
      defaultModel: "gpt-5.2",
      defaultEnableMcp: true,
      defaultBackupsEnabled: true,
      yolo: false,
    },
  ],
  threads: [
    {
      id: "thread-expired",
      workspaceId: "workspace-1",
      sessionId: "session-expired",
      legacyTranscriptId: "legacy-expired",
      title: "Expired archived chat",
      titleSource: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastMessageAt: "2026-01-02T00:00:00.000Z",
      status: "disconnected",
      messageCount: 1,
      lastEventSeq: 0,
      archived: true,
      archivedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "thread-fresh",
      workspaceId: "workspace-1",
      sessionId: "session-fresh",
      legacyTranscriptId: "legacy-fresh",
      title: "Fresh archived chat",
      titleSource: "manual",
      createdAt: "2026-01-20T00:00:00.000Z",
      lastMessageAt: "2026-01-20T00:00:00.000Z",
      status: "disconnected",
      messageCount: 1,
      lastEventSeq: 0,
      archived: true,
      archivedAt: "2026-01-20T00:00:00.000Z",
    },
  ],
  desktopSettings: {
    archivedChatsAutoDeleteDays: 7,
  },
};
const offlinePersistedState = structuredClone(persistedState) as PersistedState;
offlinePersistedState.threads[0] = {
  ...offlinePersistedState.threads[0]!,
  id: "thread-offline-expired",
  sessionId: "session-offline-expired",
  legacyTranscriptId: "legacy-offline-expired",
};
offlinePersistedState.threads[1] = {
  ...offlinePersistedState.threads[1]!,
  id: "thread-offline-fresh",
  sessionId: "session-offline-fresh",
  legacyTranscriptId: "legacy-offline-fresh",
};
let activePersistedState = persistedState;

installWindowMock();

mock.module("../src/lib/desktopCommands", () =>
  createDesktopCommandsMock({
    deleteTranscript: async ({ threadId }) => {
      deleteTranscriptCalls.push(threadId);
      callOrder.push(`transcript:${threadId}`);
    },
    loadState: async () => activePersistedState,
    saveState: async (state) => {
      savedStates.push(state);
    },
    getWorkspaceServerStatus: async ({ workspaceId }) => {
      workspaceStatusCalls.push(workspaceId);
      return serverStatusRunning
        ? { workspaceId, running: true, url: "ws://mock", reason: "running" }
        : { workspaceId, running: false, url: null, reason: "not_found" };
    },
    startWorkspaceServer: async ({ workspaceId }) => {
      startWorkspaceServerCalls.push(workspaceId);
      return { url: "ws://mock" };
    },
  }),
);

mock.module("../src/lib/agentSocket", () => ({
  JsonRpcSocket: MockJsonRpcSocket,
}));

const { useAppStore } = await import("../src/app/store");
const { RUNTIME } = await import("../src/app/store.helpers");

beforeEach(() => {
  installWindowMock();
  serverStatusRunning = true;
  activePersistedState = persistedState;
  useAppStore.setState({
    ready: false,
    bootstrapPhase: "idle",
    bootstrapStage: null,
    startupError: null,
    workspaces: [],
    threads: [],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    selectedTaskId: null,
    view: "chat",
    settingsPage: "models",
    lastNonSettingsView: "chat",
    workspaceRuntimeById: {},
    threadRuntimeById: {},
    notifications: [],
  });
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.sessionSnapshots.clear();
  RUNTIME.workspaceStartPromises.clear();
  RUNTIME.workspaceJsonRpcSocketGenerations.clear();
});

afterEach(async () => {
  useAppStore.getState().invalidateBootstrap();
  await useAppStore.getState().drainBootstrap();
  Date.now = originalDateNow;
  storage.clear();
  deleteTranscriptCalls.length = 0;
  jsonRpcRequests.length = 0;
  callOrder.length = 0;
  savedStates.length = 0;
  startWorkspaceServerCalls.length = 0;
  workspaceStatusCalls.length = 0;
  rpcReadyStates.length = 0;
  RUNTIME.jsonRpcSockets.clear();
  RUNTIME.sessionSnapshots.clear();
  RUNTIME.workspaceStartPromises.clear();
  RUNTIME.workspaceJsonRpcSocketGenerations.clear();
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }
});

describe("archived session auto-delete", () => {
  test("deletes canonical server sessions before legacy transcript projections", async () => {
    Date.now = () => Date.parse("2026-01-20T00:00:00.000Z");

    await useAppStore.getState().init();

    expect(jsonRpcRequests).toContainEqual({
      method: "cowork/session/delete",
      params: {
        cwd: "/tmp/archived-session-auto-delete",
        targetSessionId: "session-expired",
      },
    });
    expect(
      jsonRpcRequests.some((request) => request.params?.targetSessionId === "session-fresh"),
    ).toBe(false);
    expect(deleteTranscriptCalls).toEqual(["legacy-expired", "session-expired"]);
    expect(callOrder.indexOf("rpc:session-expired")).toBeLessThan(
      callOrder.indexOf("transcript:legacy-expired"),
    );
    expect(rpcReadyStates).toEqual([true]);
    expect(startWorkspaceServerCalls).toEqual([]);
    expect(useAppStore.getState().threads.map((thread) => thread.id)).toEqual(["session-fresh"]);
  });

  test("keeps offline cleanup silent without pre-hydration workspace staging", async () => {
    Date.now = () => Date.parse("2026-01-20T00:00:00.000Z");
    serverStatusRunning = false;
    activePersistedState = offlinePersistedState;
    useAppStore.setState({ view: "settings", lastNonSettingsView: "chat" });

    const observedStates: Array<{ ready: boolean; workspaceIds: string[] }> = [];
    const unsubscribe = useAppStore.subscribe((state) => {
      observedStates.push({
        ready: state.ready,
        workspaceIds: state.workspaces.map((workspace) => workspace.id),
      });
    });

    try {
      await useAppStore.getState().init();
    } finally {
      unsubscribe();
    }

    expect(jsonRpcRequests.some((request) => request.method === "cowork/session/delete")).toBe(
      false,
    );
    expect(startWorkspaceServerCalls).toEqual([]);
    expect(deleteTranscriptCalls).toEqual(["legacy-offline-expired", "session-offline-expired"]);
    expect(useAppStore.getState().threads.map((thread) => thread.id)).toEqual([
      "session-offline-fresh",
    ]);
    expect(useAppStore.getState().notifications).toEqual([]);
    expect(
      observedStates.some((state) => !state.ready && state.workspaceIds.includes("workspace-1")),
    ).toBe(false);
    expect(useAppStore.getState().bootstrapPhase).toBe("ready");
  });
});
