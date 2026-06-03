import { beforeEach, describe, expect, test } from "bun:test";

const { createWorkspaceMemoryActions } = await import("../src/app/store.actions/memory");
const { RUNTIME, defaultWorkspaceRuntime } = await import("../src/app/store.helpers/runtimeState");

const workspaceId = "ws-memory-actions";

function createState() {
  return {
    notifications: [],
    threads: [],
    workspaces: [
      {
        id: workspaceId,
        path: "/tmp/workspace",
        defaultAdvancedMemory: undefined as boolean | undefined,
        defaultMemoryGenerationModel: undefined as string | undefined,
      },
      {
        id: "ws-other",
        path: "/tmp/other",
        defaultAdvancedMemory: false as boolean | undefined,
        defaultMemoryGenerationModel: "together:moonshotai/Kimi-K2.5" as string | undefined,
      },
    ],
    workspaceRuntimeById: {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock",
        controlSessionId: null,
        memoriesLoading: false,
      },
      "ws-other": {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://mock-other",
        controlSessionId: "other-control-session",
        memoriesLoading: false,
        controlSessionConfig: {
          advancedMemory: false,
          memoryGenerationModel: "together:moonshotai/Kimi-K2.5",
        },
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

  test("advanced memory actions hit the advanced JSON-RPC methods", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: any }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          event: {
            type: "advanced_memory_list",
            sessionId: "control-session",
            folder: "proj",
            folders: ["proj"],
            memories: [],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    const actions = createWorkspaceMemoryActions(set as any, get as any);
    await actions.requestAdvancedMemories(workspaceId, { cwd: "/tmp/proj", folder: "proj" });
    await actions.upsertAdvancedMemory(
      workspaceId,
      { folder: "proj", name: "rule", description: "d", type: "feedback", body: "b" },
      { cwd: "/tmp/proj" },
    );
    await actions.deleteAdvancedMemory(workspaceId, "proj", "rule", { cwd: "/tmp/proj" });

    expect(requests.map((r) => r.method)).toEqual([
      "cowork/memory/advanced/list",
      "cowork/memory/advanced/upsert",
      "cowork/memory/advanced/delete",
    ]);
    expect(requests[1]?.params).toMatchObject({ folder: "proj", name: "rule", body: "b" });
    expect(state.workspaceRuntimeById[workspaceId].advancedMemoriesLoading).toBe(false);
  });

  test("generateAdvancedMemoryForThread targets the selected conversation", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: any }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          event: {
            type: "advanced_memory_list",
            sessionId: "thread-1",
            folder: "proj",
            folders: ["proj"],
            memories: [],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    const ok = await createWorkspaceMemoryActions(
      set as any,
      get as any,
    ).generateAdvancedMemoryForThread(workspaceId, "thread-1", {
      cwd: "/tmp/proj",
      folder: "proj",
    });

    expect(ok).toBe(true);
    expect(requests).toEqual([
      {
        method: "cowork/memory/advanced/generate",
        params: { cwd: "/tmp/proj", folder: "proj", threadId: "thread-1" },
      },
    ]);
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "info",
      title: "Memory generated",
    });
  });

  test("setWorkspaceAdvancedMemory applies the config patch globally", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: any }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          event: {
            type: "session_config",
            sessionId: "control-session",
            config: { advancedMemory: true },
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    await createWorkspaceMemoryActions(set as any, get as any).setWorkspaceAdvancedMemory(
      workspaceId,
      true,
      { cwd: "/tmp/proj" },
    );

    expect(requests[0]?.method).toBe("cowork/session/defaults/apply");
    expect(requests[0]?.params).toMatchObject({ config: { advancedMemory: true } });
    expect(state.workspaces[0].defaultAdvancedMemory).toBe(true);
    expect(state.workspaces[1].defaultAdvancedMemory).toBe(true);
    expect(state.workspaceRuntimeById["ws-other"].controlSessionConfig).toMatchObject({
      advancedMemory: true,
    });
  });

  test("setWorkspaceMemoryGenerationModel clears the desktop fallback on reset", async () => {
    const state = createState();
    state.workspaces[0].defaultMemoryGenerationModel = "gemini-old";
    state.workspaces[1].defaultMemoryGenerationModel = "together:moonshotai/Kimi-K2.5";
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    state.workspaceRuntimeById[workspaceId].controlSessionConfig = {
      advancedMemory: true,
      memoryGenerationModel: "gemini-old",
    };
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: any }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {
          event: {
            type: "session_config",
            sessionId: "control-session",
            config: { advancedMemory: true },
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    await createWorkspaceMemoryActions(set as any, get as any).setWorkspaceMemoryGenerationModel(
      workspaceId,
      "",
      { cwd: "/tmp/proj" },
    );

    expect(requests[0]?.method).toBe("cowork/session/defaults/apply");
    expect(requests[0]?.params).toMatchObject({
      config: { clearMemoryGenerationModel: true },
    });
    expect(state.workspaces[0].defaultMemoryGenerationModel).toBeUndefined();
    expect(state.workspaces[1].defaultMemoryGenerationModel).toBeUndefined();
    expect(state.workspaceRuntimeById[workspaceId].controlSessionConfig).toEqual({
      advancedMemory: true,
    });
    expect(state.workspaceRuntimeById["ws-other"].controlSessionConfig).toEqual({
      advancedMemory: false,
    });
  });
});
