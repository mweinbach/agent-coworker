import { describe, expect, test } from "bun:test";

const { createProviderActions, refreshProviderStatusForWorkspace } = await import(
  "../src/app/store.actions/provider"
);
const { RUNTIME } = await import("../src/app/store.helpers");

type TestState = {
  notifications: any[];
  operationsByKey: Record<string, unknown>;
  providerLastAuthChallenge: unknown;
  providerLastAuthResult: unknown;
  providerStatusRefreshing: boolean;
  selectedWorkspaceId: string | null;
  workspaces: Array<{ id: string; path: string }>;
  workspaceRuntimeById: Record<
    string,
    {
      controlSessionId: string | null;
      error: string | null;
      serverUrl: string | null;
      starting: boolean;
    }
  >;
};

function createHarness(): { state: TestState; get: () => TestState; set: (updater: any) => void } {
  const state: TestState = {
    notifications: [],
    operationsByKey: {},
    providerLastAuthChallenge: null,
    providerLastAuthResult: null,
    providerStatusRefreshing: false,
    selectedWorkspaceId: "ws-1",
    workspaces: [{ id: "ws-1", path: "/tmp/ws-1" }],
    workspaceRuntimeById: {
      "ws-1": {
        controlSessionId: "control-session",
        error: null,
        serverUrl: "ws://mock",
        starting: false,
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
  test("provider auth adapter returns a negative domain acknowledgment as an operation error", async () => {
    const harness = createHarness();
    RUNTIME.jsonRpcSockets.set("ws-1", {
      readyPromise: Promise.resolve(),
      connect: () => {},
      close: () => {},
      respond: () => true,
      request: async () => ({
        event: {
          type: "provider_auth_result",
          sessionId: "control-session",
          provider: "openai",
          methodId: "api_key",
          ok: false,
          message: "The API key is invalid.",
        },
      }),
    } as never);

    try {
      const actions = createProviderActions(harness.set as never, harness.get as never);
      const result = await actions.setProviderApiKey("openai", "api_key", "sk-invalid");

      expect(result).toMatchObject({
        ok: false,
        error: {
          message: "The API key is invalid.",
        },
      });
      expect(harness.state.operationsByKey["provider:api-key%3Aapi_key:openai"]).toMatchObject({
        status: "error",
        error: {
          message: "The API key is invalid.",
        },
      });
    } finally {
      RUNTIME.jsonRpcSockets.delete("ws-1");
    }
  });

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
      { method: "cowork/provider/catalog/read", params: { cwd: "/tmp/ws-1", refresh: true } },
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
      { method: "cowork/provider/catalog/read", params: { cwd: "/tmp/ws-1", refresh: true } },
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

  test("refreshProviderStatus waits for status before reading the catalog when Bedrock discovery is requested", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let releaseStatusRefresh: ((value: boolean) => void) | null = null;
    const harness = createHarness();

    const refreshPromise = refreshProviderStatusForWorkspace(
      harness.get as any,
      harness.set as any,
      "ws-1",
      "/tmp/ws-1",
      { refreshBedrockDiscovery: true },
      {
        makeId: () => "note-1",
        nowIso: () => "2026-03-21T00:00:00.000Z",
        pushNotification: (notifications: any[], entry: any) => [...notifications, entry],
        requestJsonRpcControlEvent: ((...args: any[]) => {
          const method = String(args[3]);
          const params = args[4] as Record<string, unknown>;
          calls.push({ method, params });
          if (method === "cowork/provider/status/refresh") {
            return new Promise<boolean>((resolve) => {
              releaseStatusRefresh = resolve;
            });
          }
          return Promise.resolve(true);
        }) as any,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      {
        method: "cowork/provider/status/refresh",
        params: { cwd: "/tmp/ws-1", refreshBedrockDiscovery: true },
      },
      { method: "cowork/provider/authMethods/read", params: { cwd: "/tmp/ws-1" } },
    ]);
    expect(harness.state.providerStatusRefreshing).toBe(true);

    releaseStatusRefresh?.(true);
    await refreshPromise;

    expect(calls).toEqual([
      {
        method: "cowork/provider/status/refresh",
        params: { cwd: "/tmp/ws-1", refreshBedrockDiscovery: true },
      },
      { method: "cowork/provider/authMethods/read", params: { cwd: "/tmp/ws-1" } },
      { method: "cowork/provider/catalog/read", params: { cwd: "/tmp/ws-1", refresh: true } },
    ]);
    expect(harness.state.providerStatusRefreshing).toBe(false);
    expect(harness.state.notifications).toEqual([]);
  });
});
