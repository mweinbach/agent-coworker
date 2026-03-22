import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../src/lib/desktopCommands", () => ({
  appendTranscriptBatch: async () => {},
  appendTranscriptEvent: async () => {},
  copyPath: async () => {},
  createDirectory: async () => {},
  deleteTranscript: async () => {},
  listDirectory: async () => [],
  loadState: async () => ({ version: 2, workspaces: [], threads: [] }),
  openPath: async () => {},
  pickWorkspaceDirectory: async () => null,
  readTranscript: async () => [],
  renamePath: async () => {},
  revealPath: async () => {},
  showContextMenu: async () => null,
  stopWorkspaceServer: async () => {},
  trashPath: async () => {},
  windowClose: async () => {},
  windowMaximize: async () => {},
  windowMinimize: async () => {},
}));

let requestJsonRpcControlEventImpl: (...args: any[]) => Promise<boolean> = async () => true;

mock.module("../src/app/store.helpers", () => ({
  RUNTIME: {},
  appendThreadTranscript: () => {},
  basename: (value: string) => value.split("/").filter(Boolean).at(-1) ?? value,
  buildContextPreamble: () => "",
  ensureControlSocket: () => ({}),
  ensureServerRunning: async () => {},
  ensureThreadRuntime: () => ({}),
  ensureThreadSocket: () => ({}),
  ensureWorkspaceRuntime: () => ({}),
  isProviderName: () => true,
  makeId: () => "note-1",
  mapTranscriptToFeed: () => [],
  nowIso: () => "2026-03-21T00:00:00.000Z",
  normalizeThreadTitleSource: (_source: unknown, fallbackTitle: string) => fallbackTitle,
  persistNow: async () => {},
  providerAuthMethodsFor: () => [],
  pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
  queuePendingThreadMessage: () => {},
  requestJsonRpcControlEvent: (...args: any[]) => requestJsonRpcControlEventImpl(...args),
  sendThread: () => {},
  sendUserMessageToThread: async () => {},
  truncateTitle: (value: string) => value,
}));

const { createProviderActions } = await import("../src/app/store.actions/provider");

type TestState = {
  notifications: any[];
  providerStatusRefreshing: boolean;
  selectedWorkspaceId: string | null;
  workspaces: Array<{ id: string; path: string }>;
  workspaceRuntimeById: Record<string, { controlSessionId: string | null }>;
};

function createHarness(): { state: TestState; get: () => TestState; set: (updater: any) => void } {
  const state: TestState = {
    notifications: [],
    providerStatusRefreshing: false,
    selectedWorkspaceId: "ws-1",
    workspaces: [{ id: "ws-1", path: "/tmp/ws-1" }],
    workspaceRuntimeById: {
      "ws-1": {
        controlSessionId: "control-session",
      },
    },
  };

  return {
    state,
    get: () => state,
    set: (updater: any) => {
      const patch = typeof updater === "function" ? updater(state) : updater;
      Object.assign(state, patch);
    },
  };
}

describe("provider actions", () => {
  beforeEach(() => {
    requestJsonRpcControlEventImpl = async () => true;
  });

  test("refreshProviderStatus dispatches all three RPCs before the first settles and preserves failure handling", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let resolveFirstCall: ((value: boolean) => void) | null = null;
    let callCount = 0;
    requestJsonRpcControlEventImpl = (...args: any[]) => {
      const method = String(args[3]);
      const params = args[4] as Record<string, unknown>;
      calls.push({ method, params });
      callCount += 1;

      if (callCount === 1) {
        return new Promise<boolean>((resolve) => {
          resolveFirstCall = resolve;
        });
      }

      return Promise.resolve(true);
    };

    const harness = createHarness();
    const actions = createProviderActions(harness.set as any, harness.get as any);

    const refreshPromise = actions.refreshProviderStatus();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      { method: "cowork/provider/status/refresh", params: { cwd: "/tmp/ws-1" } },
      { method: "cowork/provider/catalog/read", params: { cwd: "/tmp/ws-1" } },
      { method: "cowork/provider/authMethods/read", params: { cwd: "/tmp/ws-1" } },
    ]);
    expect(harness.state.providerStatusRefreshing).toBe(true);

    resolveFirstCall?.(false);
    await refreshPromise;

    expect(harness.state.providerStatusRefreshing).toBe(false);
    expect(harness.state.notifications).toHaveLength(1);
    expect(harness.state.notifications[0]).toMatchObject({
      kind: "error",
      title: "Not connected",
      detail: "Unable to refresh provider status.",
    });
  });
});
