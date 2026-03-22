import { beforeEach, describe, expect, test } from "bun:test";

const { createSkillActions } = await import("../src/app/store.actions/skills");
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");

const workspaceId = "ws-skills";

function createState() {
  return {
    selectedWorkspaceId: workspaceId,
    workspaceRuntimeById: {
      [workspaceId]: {
        skillCatalogLoading: false,
        skillCatalogError: "stale error",
        skillMutationPendingKeys: {},
        skillMutationError: "stale mutation error",
      },
    },
    notifications: [],
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

const failedSkillMutationActions = [
  {
    name: "disableSkillInstallation",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.disableSkillInstallation("inst-1"),
  },
  {
    name: "enableSkillInstallation",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.enableSkillInstallation("inst-1"),
  },
  {
    name: "deleteSkillInstallation",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.deleteSkillInstallation("inst-1"),
  },
  {
    name: "copySkillInstallation",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.copySkillInstallation("inst-1", "project"),
  },
  {
    name: "updateSkillInstallation",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.updateSkillInstallation("inst-1"),
  },
] as const;

describe("skill store actions", () => {
  beforeEach(() => {
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
  });

  test("refreshSkillsCatalog clears loading when sendControl fails", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set as any, get as any).refreshSkillsCatalog();

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("refreshSkillsCatalog dispatches catalog and list requests in parallel", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://mock";
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const calls: string[] = [];
    let resolveCatalog: ((value: unknown) => void) | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: (method: string) => {
        calls.push(method);
        if (method === "cowork/skills/catalog/read") {
          return new Promise((resolve) => {
            resolveCatalog = resolve;
          });
        }
        return Promise.resolve({
          event: {
            type: "skills_list",
            sessionId: "jsonrpc-control",
            skills: [],
          },
        });
      },
      respond: () => true,
      close: () => {},
    } as any);

    const refreshPromise = createSkillActions(set as any, get as any).refreshSkillsCatalog();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      "cowork/skills/catalog/read",
      "cowork/skills/list",
    ]);

    resolveCatalog?.({
      event: {
        type: "skills_catalog",
        sessionId: "jsonrpc-control",
        catalog: { installations: [], sources: [], stats: { totalInstallations: 0, enabledInstallations: 0 } },
        mutationBlocked: false,
      },
    });
    await refreshPromise;

    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.notifications).toHaveLength(0);
  });

  test("previewSkillInstall removes only its pending key when sendControl fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set as any, get as any).previewSkillInstall("owner/repo", "project");

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ other: true });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("installSkills removes only its pending key when sendControl fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
    const { get, set } = createStoreHarness(state);

    await expect(createSkillActions(set as any, get as any).installSkills("owner/repo", "global")).rejects.toThrow(
      "Unable to install skills.",
    );

    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ other: true });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.notifications).toHaveLength(1);
  });

  test("installSkills registers its waiter before sending the control message", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId].controlSessionId = "control-session";
    state.workspaceRuntimeById[workspaceId].serverUrl = "ws://mock";
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    let waiterPendingKey: string | null = null;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => {
        waiterPendingKey = RUNTIME.skillInstallWaiters.get(workspaceId)?.pendingKey ?? null;
        throw new Error("request failed");
      },
      respond: () => true,
      close: () => {},
    } as any);

    await expect(createSkillActions(set as any, get as any).installSkills("owner/repo", "global")).rejects.toThrow(
      "Unable to install skills.",
    );

    expect(waiterPendingKey).toBe("install:global");
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
  });

  for (const { name, invoke } of failedSkillMutationActions) {
    test(`${name} removes only its pending key when sendControl fails`, async () => {
      const state = createState();
      state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys = { other: true };
      const { get, set } = createStoreHarness(state);

      await invoke(createSkillActions(set as any, get as any));

      expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ other: true });
      expect(state.notifications).toHaveLength(1);
    });
  }
});
