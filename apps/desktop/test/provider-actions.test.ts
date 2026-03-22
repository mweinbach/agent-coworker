import { describe, expect, test } from "bun:test";

const { refreshProviderStatusForWorkspace } = await import("../src/app/store.actions/provider");

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
  test("refreshProviderStatus clears loading when all refresh RPCs succeed without event envelopes", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const harness = createHarness();

    await refreshProviderStatusForWorkspace(
      harness.get as any,
      harness.set as any,
      "ws-1",
      "/tmp/ws-1",
      {
        makeId: () => "note-1",
        nowIso: () => "2026-03-21T00:00:00.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) => {
          calls.push({
            method: String(args[3]),
            params: args[4] as Record<string, unknown>,
          });
          return Promise.resolve(true);
        }) as any,
      },
    );

    expect(calls).toEqual([
      { method: "cowork/provider/status/refresh", params: { cwd: "/tmp/ws-1" } },
      { method: "cowork/provider/catalog/read", params: { cwd: "/tmp/ws-1" } },
      { method: "cowork/provider/authMethods/read", params: { cwd: "/tmp/ws-1" } },
    ]);
    expect(harness.state.providerStatusRefreshing).toBe(false);
    expect(harness.state.notifications).toEqual([]);
  });

  test("refreshProviderStatus dispatches all three RPCs before the first settles and preserves failure handling", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let resolveFirstCall: ((value: boolean) => void) | null = null;
    let callCount = 0;
    const requestJsonRpcControlEvent = (...args: any[]) => {
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

    const refreshPromise = refreshProviderStatusForWorkspace(
      harness.get as any,
      harness.set as any,
      "ws-1",
      "/tmp/ws-1",
      {
        makeId: () => "note-1",
        nowIso: () => "2026-03-21T00:00:00.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: requestJsonRpcControlEvent as any,
      },
    );
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
    expect(harness.state.notifications).toEqual([
      {
        id: "note-1",
        ts: "2026-03-21T00:00:00.000Z",
        kind: "error",
        title: "Not connected",
        detail: "Unable to refresh provider status.",
      },
    ]);
  });

});
