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
        defaultSkillImprovementEnabled: undefined as boolean | undefined,
        defaultSkillImprovementModel: undefined as string | undefined,
        defaultSkillImprovementScope: undefined as "user" | "all" | undefined,
        defaultSkillImprovementExcludedSkills: undefined as string[] | undefined,
      },
      {
        id: "ws-other",
        path: "/tmp/other",
        defaultAdvancedMemory: false as boolean | undefined,
        defaultMemoryGenerationModel: "together:moonshotai/Kimi-K2.5" as string | undefined,
        defaultSkillImprovementEnabled: false as boolean | undefined,
        defaultSkillImprovementModel: "openai:gpt-5-mini" as string | undefined,
        defaultSkillImprovementScope: "user" as "user" | "all" | undefined,
        defaultSkillImprovementExcludedSkills: ["legacy"] as string[] | undefined,
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
          skillImprovementEnabled: false,
          skillImprovementModel: "openai:gpt-5-mini",
          skillImprovementScope: "user",
          skillImprovementExcludedSkills: ["legacy"],
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
      "cowork/memory/advanced/folder/list",
      "cowork/memory/advanced/folder/upsert",
      "cowork/memory/advanced/folder/delete",
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
        method: "cowork/memory/advanced/folder/generate",
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
      advancedMemory: true,
      skillImprovementEnabled: false,
      skillImprovementScope: "user",
      skillImprovementExcludedSkills: ["legacy"],
    });
  });

  test("skill improvement actions hit the improvement JSON-RPC methods", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: any }> = [];
    const statusEvent = {
      type: "skill_improvement_status",
      sessionId: "control-session",
      enabled: true,
      scope: "user",
      excludedSkills: [],
      busy: false,
      blockReason: null,
      pendingJobs: [],
      runHistory: [],
      backups: [],
      skills: [],
    };
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { event: statusEvent };
      },
      respond: () => true,
      close: () => {},
    } as any);

    const actions = createWorkspaceMemoryActions(set as any, get as any);
    // Simulate another action still in flight: status events (including
    // background broadcasts) must never clear pending keys they don't own.
    state.workspaceRuntimeById[workspaceId].skillImprovementPendingActionKeys = {
      "run:other": true,
    };
    await actions.requestSkillImprovementStatus(workspaceId, { cwd: "/tmp/proj" });
    expect(state.workspaceRuntimeById[workspaceId].skillImprovementPendingActionKeys).toEqual({
      "run:other": true,
    });
    const runOk = await actions.runSkillImprovement(workspaceId, "alpha", { cwd: "/tmp/proj" });
    const restoreOk = await actions.restoreSkillImprovement(workspaceId, "alpha", {
      cwd: "/tmp/proj",
    });

    expect(runOk).toBe(true);
    expect(restoreOk).toBe(true);
    expect(requests).toEqual([
      {
        method: "cowork/skills/improvement/status",
        params: { cwd: "/tmp/proj" },
      },
      {
        method: "cowork/skills/improvement/run",
        params: { cwd: "/tmp/proj", skillName: "alpha" },
      },
      {
        method: "cowork/skills/improvement/restore",
        params: { cwd: "/tmp/proj", skillName: "alpha" },
      },
    ]);
    expect(state.workspaceRuntimeById[workspaceId].skillImprovementStatus).toEqual(statusEvent);
    expect(state.workspaceRuntimeById[workspaceId].skillImprovementLoading).toBe(false);
    // Each action clears its own key when it settles; the foreign key survives.
    expect(state.workspaceRuntimeById[workspaceId].skillImprovementPendingActionKeys).toEqual({
      "run:other": true,
    });
  });

  test("setWorkspaceSkillImprovementExcludedSkills applies the config patch globally", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    const { get, set } = createStoreHarness(state);
    const requests: Array<{ method: string; params: any }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "cowork/session/defaults/apply") {
          return {
            event: {
              type: "session_config",
              sessionId: "control-session",
              config: {
                skillImprovementEnabled: true,
                skillImprovementScope: "all",
                skillImprovementExcludedSkills: ["alpha", "beta"],
              },
            },
          };
        }
        return {
          event: {
            type: "skill_improvement_status",
            sessionId: "control-session",
            enabled: true,
            scope: "all",
            excludedSkills: ["alpha", "beta"],
            busy: false,
            blockReason: null,
            pendingJobs: [],
            runHistory: [],
            backups: [],
            skills: [],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as any);

    await createWorkspaceMemoryActions(
      set as any,
      get as any,
    ).setWorkspaceSkillImprovementExcludedSkills(workspaceId, ["beta", "alpha", "beta"], {
      cwd: "/tmp/proj",
    });

    expect(requests[0]).toEqual({
      method: "cowork/session/defaults/apply",
      params: {
        cwd: "/tmp/proj",
        config: { skillImprovementExcludedSkills: ["alpha", "beta"] },
      },
    });
    expect(requests[1]?.method).toBe("cowork/skills/improvement/status");
    expect(state.workspaces[0].defaultSkillImprovementExcludedSkills).toEqual(["alpha", "beta"]);
    expect(state.workspaces[1].defaultSkillImprovementExcludedSkills).toEqual(["alpha", "beta"]);
    expect(state.workspaceRuntimeById["ws-other"].controlSessionConfig).toMatchObject({
      skillImprovementExcludedSkills: ["alpha", "beta"],
    });
  });
});
