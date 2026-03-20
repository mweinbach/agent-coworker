import { beforeEach, describe, expect, mock, test } from "bun:test";

class MockAgentSocket {}

mock.module("../src/lib/agentSocket", () => ({
  AgentSocket: MockAgentSocket,
}));

const { createControlSocketHelpers } = await import("../src/app/store.helpers/controlSocket");
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");

const deps = {
  nowIso: () => "2026-03-20T00:00:00.000Z",
  makeId: () => "note-1",
  persist: () => {},
  pushNotification: <T>(notifications: T[]) => notifications,
  isProviderName: () => true,
};

describe("control socket helper timeouts", () => {
  const workspaceId = "ws-timeouts";
  const state = {
    workspaceRuntimeById: {
      [workspaceId]: {
        serverUrl: "ws://mock",
        error: null,
        controlSessionId: "control-session",
      },
    },
  };
  const get = () => state as any;
  const set = (() => {}) as any;

  beforeEach(() => {
    RUNTIME.controlSockets.clear();
  });

  test("requestWorkspaceSessions unregisters timed-out waiters", async () => {
    const helpers = createControlSocketHelpers(deps, { requestTimeoutMs: 25 });
    RUNTIME.controlSockets.set(workspaceId, {
      send: () => true,
    } as any);

    const requestPromise = helpers.requestWorkspaceSessions(get, set, workspaceId);
    await Promise.resolve();

    expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(1);
    await expect(requestPromise).resolves.toBeNull();
    expect(helpers.__internal.getPendingWaiterCounts().workspaceSessionWaiters).toBe(0);
  });

  test("requestSessionSnapshot unregisters timed-out waiters", async () => {
    const helpers = createControlSocketHelpers(deps, { requestTimeoutMs: 25 });
    RUNTIME.controlSockets.set(workspaceId, {
      send: () => true,
    } as any);

    const requestPromise = helpers.requestSessionSnapshot(get, set, workspaceId, "target-session");
    await Promise.resolve();

    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(1);
    await expect(requestPromise).resolves.toBeNull();
    expect(helpers.__internal.getPendingWaiterCounts().sessionSnapshotWaiters).toBe(0);
  });
});
