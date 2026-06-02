import { beforeEach, describe, expect, test } from "bun:test";

const { createWorkspaceMemoryActions } = await import("../src/app/store.actions/memory");
const { RUNTIME, defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");

const workspaceId = "ws-memory-actions";

function createState() {
  return {
    notifications: [],
    workspaces: [{ id: workspaceId, path: "/tmp/workspace" }],
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock",
        controlSessionId: null,
        memoriesLoading: false,
      },
    },
  };
}

function createStoreHarness(state: ReturnType<typeof createState>) {
  const get = () => state as any;
  const set = (updater: any) => {
    const patch = typeof updater === "function" ? updater(state as any) : updater;
    Object.assign(state, patch);
  };
  return { get, set };
}

describe("memory store actions", () => {
  beforeEach(() => {
    RUNTIME.jsonRpcSockets.clear();
  });

  test("requestWorkspaceMemories does not leave loading stuck while the control session is still handshaking", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: new Promise(() => {}),
      request: async () => ({}),
      respond: () => true,
      close: () => {},
    } as any);

    await createWorkspaceMemoryActions(set as any, get as any).requestWorkspaceMemories(
      workspaceId,
    );

    expect(state.workspaceRuntimeById[workspaceId].memoriesLoading).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  test("requestWorkspaceMemories can target a shared memory cwd", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: unknown }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          event: {
            type: "memory_list",
            sessionId: "control-session",
            memories: [],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    await createWorkspaceMemoryActions(set as any, get as any).requestWorkspaceMemories(
      workspaceId,
      { cwd: "/tmp/shared-chats" },
    );

    expect(requests).toEqual([
      {
        method: "cowork/memory/list",
        params: { cwd: "/tmp/shared-chats" },
      },
    ]);
    expect(state.workspaceRuntimeById[workspaceId].memoriesLoading).toBe(false);
  });
});
