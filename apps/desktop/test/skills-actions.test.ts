import { beforeEach, describe, expect, test } from "bun:test";

import { defaultWorkspaceRuntime } from "../src/app/store.helpers/runtimeState";

const { createSkillActions } = await import("../src/app/store.actions/skills");
const { reactivateWorkspaceJsonRpcState } = await import("../src/app/store.helpers");
const { RUNTIME } = await import("../src/app/store.helpers/runtimeState");

/** Distinct from control-socket tests (`ws-skills`) so parallel CI runs do not share disposed JSON-RPC state. */
const workspaceId = "ws-skills-store-actions";

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

const failedPluginMutationActions = [
  {
    name: "enablePlugin",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.enablePlugin("plugin-1"),
  },
  {
    name: "disablePlugin",
    invoke: (actions: ReturnType<typeof createSkillActions>) => actions.disablePlugin("plugin-1"),
  },
] as const;

describe("skill store actions", () => {
  beforeEach(() => {
    RUNTIME.jsonRpcSockets.clear();
    RUNTIME.skillInstallWaiters.clear();
    reactivateWorkspaceJsonRpcState(workspaceId);
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

  test("refreshPluginsCatalog clears loading when sendControl fails", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);

    await createSkillActions(set as any, get as any).refreshPluginsCatalog();

    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBe("Unable to refresh plugins catalog.");
    expect(state.notifications).toHaveLength(1);
  });

  test("refreshPluginsCatalog requests the plugin catalog and clears loading after success", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      pluginsLoading: false,
      pluginsError: "stale plugin error",
    } as any;
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    let resolveCatalog!: (value: unknown) => void;
    const catalogPromise = new Promise((resolve) => {
      resolveCatalog = resolve;
    });
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: (method: string) => {
        expect(method).toBe("cowork/plugins/catalog/read");
        return catalogPromise;
      },
      respond: () => true,
      close: () => {},
    } as any);

    const refreshPromise = createSkillActions(set as any, get as any).refreshPluginsCatalog();
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(true);
    resolveCatalog({
      event: {
        type: "plugins_catalog",
        sessionId: "jsonrpc-control",
        catalog: { plugins: [], warnings: [] },
      },
    });
    await refreshPromise;

    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
    expect(state.notifications).toHaveLength(0);
  });

  test("selectPlugin enters loading state before the request and preserves loaded detail after success", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      pluginsCatalog: {
        plugins: [],
        warnings: [],
      },
    } as any;
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const plugin = {
      id: "plugin-1",
      name: "figma-toolkit",
      displayName: "Figma Toolkit",
      description: "Figma helpers",
      scope: "workspace",
      discoveryKind: "marketplace",
      enabled: true,
      rootDir: "/tmp/workspace/.agents/plugins/figma-toolkit",
      manifestPath: "/tmp/workspace/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
      skillsPath: "/tmp/workspace/.agents/plugins/figma-toolkit/skills",
      skills: [],
      mcpServers: [],
      apps: [],
      warnings: [],
    };

    let resolveRequest!: (value: unknown) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => await requestPromise,
      respond: () => true,
      close: () => {},
    } as any);

    const selectPromise = createSkillActions(set as any, get as any).selectPlugin("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBe("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(true);

    resolveRequest({
      event: {
        type: "plugin_detail",
        sessionId: "jsonrpc-control",
        plugin,
      },
    });
    await selectPromise;

    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBe("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toEqual(plugin);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
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

  test("selectSkill preserves loaded content after the JSON-RPC read succeeds", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      skillCatalogLoading: false,
      skillCatalogError: null,
      skillMutationPendingKeys: {},
      skillMutationError: null,
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      skills: [{
        name: "example-skill",
        description: "Example skill",
        source: "workspace",
        enabled: true,
        effective: true,
        interface: null,
        metadata: null,
        path: "/tmp/workspace/skills/example-skill/SKILL.md",
      }],
    } as any;
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "skill_content",
          sessionId: "jsonrpc-control",
          skill: state.workspaceRuntimeById[workspaceId].skills[0],
          content: "# Example skill",
        },
      }),
      respond: () => true,
      close: () => {},
    } as any);

    await createSkillActions(set as any, get as any).selectSkill("example-skill");

    expect(state.workspaceRuntimeById[workspaceId].selectedSkillName).toBe("example-skill");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBe("# Example skill");
  });

  test("selectSkillInstallation enters loading state before the request and preserves loaded detail after success", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      skillCatalogLoading: false,
      skillCatalogError: null,
      skillMutationPendingKeys: {},
      skillMutationError: null,
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    } as any;
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const installation = {
      installationId: "inst-1",
      name: "example-skill",
      description: "Example skill",
      scope: "global",
      enabled: true,
      writable: false,
      managed: false,
      effective: true,
      state: "effective",
      rootDir: "/tmp/workspace/skills/example-skill",
      skillPath: "/tmp/workspace/skills/example-skill/SKILL.md",
      path: "/tmp/workspace/skills/example-skill/SKILL.md",
      triggers: [],
      descriptionSource: "unknown",
      diagnostics: [],
    };

    let resolveRequest!: (value: unknown) => void;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => await requestPromise,
      respond: () => true,
      close: () => {},
    } as any);

    const selectPromise = createSkillActions(set as any, get as any).selectSkillInstallation("inst-1");

    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallationId).toBe("inst-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallation).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBeNull();

    resolveRequest({
      event: {
        type: "skill_installation",
        sessionId: "jsonrpc-control",
        installation,
        content: "# Example skill",
      },
    });
    await selectPromise;

    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallationId).toBe("inst-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillInstallation).toEqual(installation);
    expect(state.workspaceRuntimeById[workspaceId].selectedSkillContent).toBe("# Example skill");
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

  for (const { name, invoke } of failedPluginMutationActions) {
    test(`${name} removes only its pending key when sendControl fails`, async () => {
      const state = createState();
      state.workspaceRuntimeById[workspaceId] = {
        ...defaultWorkspaceRuntime(),
        skillMutationPendingKeys: { other: true },
      } as any;
      state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
      const { get, set } = createStoreHarness(state);

      await invoke(createSkillActions(set as any, get as any));

      expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({ other: true });
      expect(state.notifications).toHaveLength(1);
    });
  }
});
