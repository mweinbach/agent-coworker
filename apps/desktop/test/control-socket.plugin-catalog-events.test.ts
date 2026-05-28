import { describe, expect, test } from "bun:test";
import {
  createControlSocketHelpers,
  createState,
  defaultWorkspaceRuntime,
  deps,
  flushAsyncWork,
  installFakeSocket,
  MockJsonRpcSocket,
  registerControlSocketLifecycleHooks,
} from "./control-socket.harness";

describe("control socket plugin catalog events", () => {
  registerControlSocketLifecycleHooks();

  test("requestJsonRpcControlEvent applies plugin catalog events and clears matching pending keys", async () => {
    const workspaceId = "ws-plugins";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          selectedPluginId: "plugin-1",
          selectedPluginScope: "workspace",
          pluginMutationPendingKeys: {
            "plugin:enable:workspace:plugin-1": true,
            other: true,
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/catalog/read");
      return {
        event: {
          type: "plugins_catalog",
          sessionId: "jsonrpc-control",
          clearedMutationPendingKeys: ["plugin:enable:workspace:plugin-1"],
          catalog: {
            warnings: [],
            plugins: [
              {
                id: "plugin-1",
                name: "figma-toolkit",
                displayName: "Figma Toolkit",
                description: "Figma helpers",
                scope: "workspace",
                discoveryKind: "marketplace",
                installed: true,
                enabled: true,
                rootDir: "/tmp/workspace/.agents/plugins/figma-toolkit",
                manifestPath:
                  "/tmp/workspace/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
                skillsPath: "/tmp/workspace/.agents/plugins/figma-toolkit/skills",
                skills: [],
                mcpServers: [],
                apps: [],
                warnings: [],
              },
            ],
            availablePlugins: [],
          },
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsCatalog?.plugins).toHaveLength(1);
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin?.id).toBe("plugin-1");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("workspace");
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({
      other: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
  });

  test("requestJsonRpcControlEvent keeps marketplace entries during partial plugin catalog refreshes", async () => {
    const workspaceId = "ws-partial-plugins";
    const marketplacePlugin = {
      id: "plugin-marketplace",
      name: "marketplace-tools",
      displayName: "Marketplace Tools",
      description: "Remote plugin helpers",
      scope: "user",
      discoveryKind: "marketplace",
      installed: false,
      enabled: false,
      marketplace: {
        name: "cowork-marketplace",
        displayName: "Cowork Marketplace",
        category: "Productivity",
      },
      installSource: "github:mweinbach/marketplace-tools",
      warnings: [],
    };
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          selectedPluginId: "plugin-marketplace",
          selectedPluginScope: "user",
          selectedPlugin: marketplacePlugin,
          pluginsCatalog: {
            warnings: [],
            plugins: [],
            availablePlugins: [marketplacePlugin],
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/catalog/read");
      return {
        event: {
          type: "plugins_catalog",
          sessionId: "jsonrpc-control",
          availablePluginsPartial: true,
          catalog: {
            warnings: [],
            plugins: [],
            availablePlugins: [],
          },
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].pluginsCatalog?.availablePlugins).toEqual([
      marketplacePlugin,
    ]);
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toEqual(marketplacePlugin);
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBe("plugin-marketplace");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("user");
  });

  test("requestJsonRpcControlEvent preserves available plugins across local mutation catalog snapshots", async () => {
    const workspaceId = "ws-plugins-available";
    const availablePlugin = {
      id: "figma-marketplace",
      name: "figma-marketplace",
      displayName: "Figma Marketplace",
      description: "Install Figma helpers",
      scope: "user" as const,
      discoveryKind: "marketplace" as const,
      installed: false as const,
      enabled: false as const,
      marketplace: { name: "figma-marketplace" },
      installSource: "builtin://figma-marketplace",
      warnings: [],
    };
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsCatalog: {
            warnings: [],
            plugins: [],
            availablePlugins: [
              availablePlugin,
              {
                ...availablePlugin,
                id: "installed-marketplace",
                name: "installed-marketplace",
                displayName: "Installed Marketplace",
              },
            ],
          },
          selectedPluginId: "figma-marketplace",
          selectedPluginScope: "user",
          selectedPlugin: availablePlugin,
          pluginMutationPendingKeys: {
            "plugin:enable:user:installed-marketplace": true,
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/catalog/read");
      return {
        event: {
          type: "plugins_catalog",
          sessionId: "jsonrpc-control",
          availablePluginsPartial: true,
          clearedMutationPendingKeys: ["plugin:enable:user:installed-marketplace"],
          catalog: {
            warnings: [],
            plugins: [
              {
                id: "installed-marketplace",
                name: "installed-marketplace",
                displayName: "Installed Marketplace",
                description: "Installed helpers",
                scope: "user",
                discoveryKind: "marketplace",
                installed: true,
                enabled: true,
                rootDir: "/tmp/home/.agents/plugins/installed-marketplace",
                manifestPath:
                  "/tmp/home/.agents/plugins/installed-marketplace/.codex-plugin/plugin.json",
                skillsPath: "/tmp/home/.agents/plugins/installed-marketplace/skills",
                skills: [],
                mcpServers: [],
                apps: [],
                warnings: [],
              },
            ],
            availablePlugins: [],
          },
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].pluginsCatalog?.availablePlugins).toEqual([
      expect.objectContaining({ id: "figma-marketplace" }),
    ]);
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin?.id).toBe("figma-marketplace");
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("user");
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({});
  });

  test("requestJsonRpcControlEvent lets authoritative empty marketplace snapshots clear stale available plugins", async () => {
    const workspaceId = "ws-plugins-available-authoritative-empty";
    const staleAvailablePlugin = {
      id: "delisted-marketplace",
      name: "delisted-marketplace",
      displayName: "Delisted Marketplace",
      description: "No longer listed",
      scope: "user" as const,
      discoveryKind: "marketplace" as const,
      installed: false as const,
      enabled: false as const,
      marketplace: { name: "delisted-marketplace" },
      installSource: "builtin://delisted-marketplace",
      warnings: [],
    };
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsCatalog: {
            warnings: [],
            plugins: [],
            availablePlugins: [staleAvailablePlugin],
          },
          selectedPluginId: "delisted-marketplace",
          selectedPluginScope: "user",
          selectedPlugin: staleAvailablePlugin,
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/catalog/read");
      return {
        event: {
          type: "plugins_catalog",
          sessionId: "jsonrpc-control",
          catalog: {
            warnings: [],
            plugins: [],
            availablePlugins: [],
          },
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/catalog/read",
      { cwd: "/tmp/workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].pluginsCatalog?.availablePlugins).toEqual([]);
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginId).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBeNull();
  });

  test("requestJsonRpcControlEvent applies plugin detail events", async () => {
    const workspaceId = "ws-plugin-detail";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          selectedPluginId: "plugin-1",
          selectedPluginScope: "workspace",
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/read");
      return {
        event: {
          type: "plugin_detail",
          sessionId: "jsonrpc-control",
          plugin: {
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
          },
        },
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/read",
      { cwd: "/tmp/workspace", pluginId: "plugin-1", scope: "workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].selectedPlugin?.displayName).toBe(
      "Figma Toolkit",
    );
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginScope).toBe("workspace");
  });

  test("control notifications apply background plugin refresh events", async () => {
    const workspaceId = "ws-control-notification";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsCatalog: null,
        },
      },
    });

    const helpers = createControlSocketHelpers(deps);
    helpers.ensureControlSocket(get as any, set as any, workspaceId);
    await flushAsyncWork();

    const socket = MockJsonRpcSocket.instances.at(-1);
    if (!socket?.opts.onNotification) {
      throw new Error("missing JSON-RPC notification handler");
    }

    socket.opts.onNotification({
      method: "cowork/control/event",
      params: {
        type: "plugins_catalog",
        sessionId: "jsonrpc-control",
        catalog: {
          warnings: [],
          plugins: [
            {
              id: "plugin-1",
              name: "figma-toolkit",
              displayName: "Figma Toolkit",
              description: "Figma helpers",
              scope: "user",
              discoveryKind: "direct",
              installed: true,
              enabled: true,
              rootDir: "/tmp/home/.agents/plugins/figma-toolkit",
              manifestPath: "/tmp/home/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json",
              skillsPath: "/tmp/home/.agents/plugins/figma-toolkit/skills",
              skills: [],
              mcpServers: [],
              apps: [],
              warnings: [],
            },
          ],
          availablePlugins: [],
        },
      },
    });

    expect(state.workspaceRuntimeById[workspaceId].pluginsCatalog?.plugins).toEqual([
      expect.objectContaining({
        id: "plugin-1",
        scope: "user",
      }),
    ]);
  });

  test("requestJsonRpcControlEvent clears plugin loading after install preview success", async () => {
    const workspaceId = "ws-plugin-preview";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          pluginMutationPendingKeys: {
            "plugin:preview": true,
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/install/preview");
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
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/install/preview",
      { cwd: "/tmp/workspace", sourceInput: "owner/repo", targetScope: "workspace" },
    );

    expect(ok).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({});
  });
});
