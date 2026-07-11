import { beforeEach, describe, expect, test } from "bun:test";
import type { JsonRpcSocket } from "../src/lib/agentSocket";
import {
  createState,
  createStoreHarness,
  defaultWorkspaceRuntime,
  RUNTIME,
  resetSkillPluginActionRuntime,
  secondaryWorkspaceId,
  workspaceId,
} from "./skill-plugin-actions.harness";

const pluginActionsModule = await import("../src/app/store.actions/plugins");
const { createPluginActions } = pluginActionsModule;

const failedPluginMutationActions = [
  {
    name: "enablePlugin",
    pendingKey: "plugin:enable:workspace:plugin-1",
    invoke: (actions: ReturnType<typeof createPluginActions>) =>
      actions.enablePlugin("plugin-1", "workspace"),
  },
  {
    name: "disablePlugin",
    pendingKey: "plugin:disable:workspace:plugin-1",
    invoke: (actions: ReturnType<typeof createPluginActions>) =>
      actions.disablePlugin("plugin-1", "workspace"),
  },
  {
    name: "deletePlugin",
    pendingKey: "plugin:delete:workspace:plugin-1",
    invoke: (actions: ReturnType<typeof createPluginActions>) =>
      actions.deletePlugin("plugin-1", "workspace"),
  },
  {
    name: "updatePlugin",
    pendingKey: "plugin:update:workspace:plugin-1",
    invoke: (actions: ReturnType<typeof createPluginActions>) =>
      actions.updatePlugin("plugin-1", "workspace"),
  },
] as const;

describe("plugin store actions", () => {
  beforeEach(() => {
    resetSkillPluginActionRuntime();
  });

  test("refreshPluginsCatalog clears loading when sendControl fails", async () => {
    const state = createState();
    const { get, set } = createStoreHarness(state);

    await createPluginActions(set, get).refreshPluginsCatalog();

    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBe(
      "Unable to refresh plugins catalog.",
    );
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
    };
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
    } as unknown as JsonRpcSocket);

    const refreshPromise = createPluginActions(set, get).refreshPluginsCatalog();
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(true);
    resolveCatalog({
      event: {
        type: "plugins_catalog",
        sessionId: "jsonrpc-control",
        catalog: { plugins: [], availablePlugins: [], warnings: [] },
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
        availablePlugins: [],
        warnings: [],
      },
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const plugin = {
      id: "plugin-1",
      name: "figma-toolkit",
      displayName: "Figma Toolkit",
      description: "Figma helpers",
      scope: "workspace",
      discoveryKind: "marketplace",
      installed: true,
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
      request: async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe("cowork/plugins/read");
        expect(params).toEqual({
          cwd: "/tmp/workspace",
          pluginId: "plugin-1",
          scope: "workspace",
        });
        return await requestPromise;
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    const selectPromise = createPluginActions(set, get).selectPlugin("plugin-1", "workspace");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBe("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("workspace");
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
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("workspace");
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toEqual(plugin);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
  });

  test("selectPlugin preserves the selected plugin when the detail request fails", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      selectedPluginId: "plugin-1",
      selectedPluginScope: "workspace",
      pluginsError: null,
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "error",
          sessionId: "jsonrpc-control",
          message: "Plugin detail request failed.",
          code: "validation_failed",
          source: "session",
        },
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).selectPlugin("plugin-1", "workspace");

    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBe("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("workspace");
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBe(
      "Unable to load plugin details.",
    );
  });

  test("previewPluginInstall targets the selected workspace", async () => {
    const state = createState();
    const managementWorkspaceId = "ws-plugin-management";
    state.selectedWorkspaceId = managementWorkspaceId;
    state.workspaceRuntimeById = {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
      },
      [managementWorkspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://management",
        controlSessionId: "jsonrpc-control",
      },
    };
    state.workspaces = [
      { id: workspaceId, path: "/tmp/workspace" },
      { id: managementWorkspaceId, path: "/tmp/management" },
    ];
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    RUNTIME.jsonRpcSockets.set(managementWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return {
          event: {
            type: "plugin_install_preview",
            sessionId: "jsonrpc-control",
            fromUserPreviewRequest: true,
            preview: {
              source: {
                kind: "github_shorthand",
                raw: "owner/repo",
                displaySource: "https://github.com/owner/repo",
                url: "https://github.com/owner/repo",
                repo: "owner/repo",
              },
              targetScope: "workspace",
              candidates: [],
              warnings: [],
            },
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).previewPluginInstall("owner/repo", "workspace");

    expect(requests).toEqual([
      {
        method: "cowork/plugins/install/preview",
        params: {
          cwd: "/tmp/management",
          sourceInput: "owner/repo",
          targetScope: "workspace",
        },
      },
    ]);
    expect(
      state.workspaceRuntimeById[managementWorkspaceId].selectedPluginPreview?.targetScope,
    ).toBe("workspace");
    expect(state.workspaceRuntimeById[managementWorkspaceId].pluginMutationPendingKeys).toEqual({});
  });

  test("installPlugins registers its waiter on the selected workspace", async () => {
    const state = createState();
    const managementWorkspaceId = "ws-plugin-management";
    state.selectedWorkspaceId = managementWorkspaceId;
    state.workspaceRuntimeById = {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
      },
      [managementWorkspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://management",
        controlSessionId: "jsonrpc-control",
      },
    };
    state.workspaces = [
      { id: workspaceId, path: "/tmp/workspace" },
      { id: managementWorkspaceId, path: "/tmp/management" },
    ];
    const { get, set } = createStoreHarness(state);

    let waiterPendingKey: string | null = null;
    let requestedParams: Record<string, unknown> | null = null;
    RUNTIME.jsonRpcSockets.set(managementWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async (_method: string, params: Record<string, unknown>) => {
        waiterPendingKey =
          RUNTIME.pluginInstallWaiters.get(managementWorkspaceId)?.pendingKey ?? null;
        requestedParams = params;
        throw new Error("request failed");
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await expect(
      createPluginActions(set, get).installPlugins("owner/repo", "user"),
    ).resolves.toMatchObject({
      ok: false,
      error: { message: "request failed" },
    });

    expect(waiterPendingKey).toBe("plugin:install:user");
    expect(requestedParams).toEqual({
      cwd: "/tmp/management",
      sourceInput: "owner/repo",
      targetScope: "user",
    });
    expect(RUNTIME.pluginInstallWaiters.has(managementWorkspaceId)).toBe(false);
  });

  test("installPlugins preserves server-side error details", async () => {
    const state = createState();
    const managementWorkspaceId = "ws-plugin-management";
    state.selectedWorkspaceId = managementWorkspaceId;
    state.workspaceRuntimeById = {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
      },
      [managementWorkspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://management",
        controlSessionId: "jsonrpc-control",
      },
    };
    state.workspaces = [
      { id: workspaceId, path: "/tmp/workspace" },
      { id: managementWorkspaceId, path: "/tmp/management" },
    ];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(managementWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        events: [
          {
            type: "error",
            sessionId: "jsonrpc-control",
            message: "Ambiguous plugin source; choose workspace or global explicitly.",
            code: "validation_failed",
            source: "session",
          },
        ],
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await expect(
      createPluginActions(set, get).installPlugins("owner/repo", "user"),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        message: "Ambiguous plugin source; choose workspace or global explicitly.",
      },
    });

    expect(state.workspaceRuntimeById[managementWorkspaceId].pluginMutationError).toBe(
      "Ambiguous plugin source; choose workspace or global explicitly.",
    );
    expect(state.workspaceRuntimeById[managementWorkspaceId].skillMutationError).toBeNull();
    expect(state.workspaceRuntimeById[managementWorkspaceId].pluginsError).toBeNull();
    expect(state.notifications.at(-1)?.detail).toContain(
      "Ambiguous plugin source; choose workspace or global explicitly.",
    );
  });

  test("installPlugins refreshes other open workspaces after a user-scoped install succeeds", async () => {
    const state = createState();
    state.workspaceRuntimeById = {
      [workspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://source",
        controlSessionId: "jsonrpc-control",
        skillMutationError: "stale skill mutation error",
      },
      [secondaryWorkspaceId]: {
        ...defaultWorkspaceRuntime(),
        serverUrl: "ws://secondary",
        controlSessionId: "jsonrpc-control",
      },
    };
    state.workspaces = [
      { id: workspaceId, path: "/tmp/workspace" },
      { id: secondaryWorkspaceId, path: "/tmp/secondary" },
    ];
    const { get, set } = createStoreHarness(state);

    const sourceCalls: string[] = [];
    const secondaryCalls: string[] = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string) => {
        sourceCalls.push(method);
        expect(method).toBe("cowork/plugins/install");
        return {
          events: [
            {
              type: "skills_catalog",
              sessionId: "jsonrpc-control",
              catalog: {
                installations: [],
                sources: [],
                stats: { totalInstallations: 0, enabledInstallations: 0 },
              },
              mutationBlocked: false,
              clearedMutationPendingKeys: ["plugin:install:user"],
            },
            {
              type: "plugins_catalog",
              sessionId: "jsonrpc-control",
              catalog: { plugins: [], availablePlugins: [], warnings: [] },
              clearedMutationPendingKeys: ["plugin:install:user"],
            },
          ],
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);
    RUNTIME.jsonRpcSockets.set(secondaryWorkspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string) => {
        secondaryCalls.push(method);
        if (method === "cowork/plugins/catalog/read") {
          return {
            event: {
              type: "plugins_catalog",
              sessionId: "jsonrpc-control",
              catalog: { plugins: [], availablePlugins: [], warnings: [] },
            },
          };
        }
        if (method === "cowork/skills/catalog/read") {
          return {
            event: {
              type: "skills_catalog",
              sessionId: "jsonrpc-control",
              catalog: {
                installations: [],
                sources: [],
                stats: { totalInstallations: 0, enabledInstallations: 0 },
              },
              mutationBlocked: false,
            },
          };
        }
        if (method === "cowork/skills/list") {
          return { event: { type: "skills_list", sessionId: "jsonrpc-control", skills: [] } };
        }
        if (method === "cowork/mcp/servers/read") {
          return {
            event: {
              type: "mcp_servers",
              sessionId: "jsonrpc-control",
              servers: [],
              legacy: [],
              files: [],
              warnings: [],
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).installPlugins("owner/repo", "user");

    expect(sourceCalls).toEqual(["cowork/plugins/install"]);
    expect(secondaryCalls.sort()).toEqual([
      "cowork/mcp/servers/read",
      "cowork/plugins/catalog/read",
      "cowork/skills/catalog/read",
      "cowork/skills/list",
    ]);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(
      "stale skill mutation error",
    );
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({});
  });

  test("refreshPluginsCatalog targets the selected workspace", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      pluginsLoading: false,
      pluginsError: "stale plugin error",
    };
    const { get, set } = createStoreHarness(state);

    const requests: string[] = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string) => {
        requests.push(method);
        return {
          event: {
            type: "plugins_catalog",
            sessionId: "jsonrpc-control",
            catalog: { plugins: [], availablePlugins: [], warnings: [] },
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).refreshPluginsCatalog();

    expect(requests).toEqual(["cowork/plugins/catalog/read"]);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
  });

  test("enablePlugin and disablePlugin preserve server-side error details", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    let requestCount = 0;
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => {
        requestCount += 1;
        return {
          events: [
            {
              type: "error",
              sessionId: "jsonrpc-control",
              message:
                requestCount === 1
                  ? "Plugin is shadowed by a global install."
                  : "Plugin is already disabled.",
              code: "validation_failed",
              source: "session",
            },
          ],
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).enablePlugin("plugin-1", "workspace");
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBe(
      "Plugin is shadowed by a global install.",
    );
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
    expect(state.notifications.at(-1)?.detail).toContain("Plugin is shadowed by a global install.");

    await createPluginActions(set, get).disablePlugin("plugin-1", "workspace");
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBe(
      "Plugin is already disabled.",
    );
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
    expect(state.notifications.at(-1)?.detail).toContain("Plugin is already disabled.");
  });

  test("deletePlugin keeps the selected plugin visible when the server returns an error", async () => {
    const state = createState();
    const selectedPlugin = {
      id: "plugin-1",
      name: "plugin-1",
      displayName: "Plugin One",
      description: "Plugin",
      scope: "workspace" as const,
      discoveryKind: "direct" as const,
      installed: true as const,
      enabled: true,
      rootDir: "/tmp/workspace/.cowork/plugins/plugin-1",
      manifestPath: "/tmp/workspace/.cowork/plugins/plugin-1/.cowork-plugin/plugin.json",
      skillsPath: "/tmp/workspace/.cowork/plugins/plugin-1/skills",
      skills: [],
      mcpServers: [],
      apps: [],
      warnings: [],
    };
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      selectedPluginId: "plugin-1",
      selectedPluginScope: "workspace",
      selectedPlugin,
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async () => ({
        event: {
          type: "error",
          sessionId: "jsonrpc-control",
          message: "Plugin cannot be deleted while it is enabled.",
          code: "validation_failed",
          source: "session",
        },
      }),
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).deletePlugin("plugin-1", "workspace");

    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBe("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("workspace");
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toEqual(selectedPlugin);
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBe(
      "Plugin cannot be deleted while it is enabled.",
    );
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({});
  });

  test("plugin mutations resolve ambiguous scopes before sending requests", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      pluginsCatalog: {
        plugins: [
          {
            id: "plugin-1",
            name: "plugin-1",
            displayName: "Plugin One",
            description: "Plugin",
            scope: "workspace",
            discoveryKind: "direct",
            installed: true,
            enabled: false,
            rootDir: "/tmp/workspace/.cowork/plugins/plugin-1",
            manifestPath: "/tmp/workspace/.cowork/plugins/plugin-1/.cowork-plugin/plugin.json",
            skillsPath: "/tmp/workspace/.cowork/plugins/plugin-1/skills",
            skills: [],
            mcpServers: [],
            apps: [],
            warnings: [],
          },
        ],
        availablePlugins: [],
        warnings: [],
      },
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return {
          event: {
            type: "plugins_catalog",
            sessionId: "jsonrpc-control",
            catalog: { plugins: [], availablePlugins: [], warnings: [] },
            clearedMutationPendingKeys: ["plugin:enable:workspace:plugin-1"],
          },
        };
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).enablePlugin("plugin-1");

    expect(requests).toEqual([
      {
        method: "cowork/plugins/enable",
        params: {
          cwd: "/tmp/workspace",
          pluginId: "plugin-1",
          scope: "workspace",
        },
      },
    ]);
  });

  test("updatePlugin clears its pending key after a successful update request", async () => {
    const state = createState();
    state.workspaceRuntimeById[workspaceId] = {
      ...defaultWorkspaceRuntime(),
      serverUrl: "ws://mock",
      controlSessionId: "jsonrpc-control",
      pluginMutationPendingKeys: { other: true },
    };
    state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
    const { get, set } = createStoreHarness(state);

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    RUNTIME.jsonRpcSockets.set(workspaceId, {
      readyPromise: Promise.resolve(),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        return {};
      },
      respond: () => true,
      close: () => {},
    } as unknown as JsonRpcSocket);

    await createPluginActions(set, get).updatePlugin("plugin-1", "workspace");

    expect(requests).toEqual([
      {
        method: "cowork/plugins/update",
        params: {
          cwd: "/tmp/workspace",
          pluginId: "plugin-1",
          scope: "workspace",
        },
      },
    ]);
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({
      other: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBeNull();
  });

  for (const { name, pendingKey, invoke } of failedPluginMutationActions) {
    test(`${name} removes only its pending key when sendControl fails`, async () => {
      const state = createState();
      state.workspaceRuntimeById[workspaceId] = {
        ...defaultWorkspaceRuntime(),
        pluginMutationPendingKeys: { other: true },
      };
      state.workspaces = [{ id: workspaceId, path: "/tmp/workspace" }];
      const { get, set } = createStoreHarness(state);

      await invoke(createPluginActions(set, get));

      expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({
        other: true,
      });
      expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys[pendingKey]).toBe(
        undefined,
      );
      expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
      expect(state.notifications).toHaveLength(1);
    });
  }
});
