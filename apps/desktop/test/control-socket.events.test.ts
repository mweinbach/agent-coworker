import { describe, expect, test } from "bun:test";
import {
  clearJsonRpcSocketOverride,
  createControlSocketHelpers,
  createState,
  defaultWorkspaceRuntime,
  deps,
  ensureWorkspaceJsonRpcSocket,
  flushAsyncWork,
  installFakeSocket,
  jsonRpcHandlers,
  jsonRpcRequests,
  MockJsonRpcSocket,
  makeThread,
  makeThreadListEntry,
  persistCalls,
  RUNTIME,
  registerControlSocketLifecycleHooks,
  setJsonRpcSocketOverride,
} from "./control-socket.harness";

describe("control socket helpers over JSON-RPC", () => {
  registerControlSocketLifecycleHooks();

  test("requestJsonRpcControlEvent resolves matching skill install waiters", async () => {
    const workspaceId = "ws-skills";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillMutationPendingKeys: {
            preview: true,
            "install:project": true,
          },
        },
      },
    });
    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/skills/catalog/read");
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
          clearedMutationPendingKeys: ["install:project"],
        },
      };
    });

    const resolved = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:project",
      resolve: resolved.resolve,
      reject: resolved.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/skills/catalog/read",
      {
        cwd: "/tmp/workspace",
      },
    );

    await resolved.promise;
    expect(ok).toBe(true);
    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      preview: true,
    });
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
  });

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

  test("requestJsonRpcControlEvent applies plugin install event arrays without clobbering a newer preview", async () => {
    const workspaceId = "ws-plugin-install-events";
    const existingPreview = {
      source: {
        kind: "github_shorthand",
        raw: "owner/newer-repo",
        displaySource: "https://github.com/owner/newer-repo",
        url: "https://github.com/owner/newer-repo",
        repo: "owner/newer-repo",
      },
      targetScope: "workspace" as const,
      candidates: [
        {
          pluginId: "newer-plugin",
          displayName: "Newer Plugin",
          description: "Newer preview",
          relativeRootPath: ".",
          wouldBePrimary: true,
          shadowedPluginIds: [],
          diagnostics: [],
        },
      ],
      warnings: [],
    };
    const installPreview = {
      source: {
        kind: "github_shorthand",
        raw: "owner/older-repo",
        displaySource: "https://github.com/owner/older-repo",
        url: "https://github.com/owner/older-repo",
        repo: "owner/older-repo",
      },
      targetScope: "workspace" as const,
      candidates: [
        {
          pluginId: "plugin-1",
          displayName: "Installed Plugin",
          description: "Installed from older preview",
          relativeRootPath: ".",
          wouldBePrimary: true,
          shadowedPluginIds: [],
          diagnostics: [],
        },
      ],
      warnings: [],
    };

    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          selectedPluginPreview: existingPreview,
          skillMutationError: "stale skill mutation error",
          pluginMutationPendingKeys: {
            "plugin:preview": true,
            "plugin:install:workspace": true,
          },
        },
      },
    });

    let waiterResolved = false;
    const installWaiter = Promise.withResolvers<void>();
    installWaiter.promise.then(() => {
      waiterResolved = true;
    });
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install:workspace",
      resolve: installWaiter.resolve,
      reject: installWaiter.reject,
    });

    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/install");
      return {
        events: [
          {
            type: "plugin_install_preview",
            sessionId: "jsonrpc-control",
            preview: installPreview,
            fromUserPreviewRequest: false,
          },
          {
            type: "skills_list",
            sessionId: "jsonrpc-control",
            skills: [
              {
                name: "plugin-1:import-frame",
                description: "Import a frame",
                plugin: {
                  id: "plugin-1",
                  name: "installed-plugin",
                  displayName: "Installed Plugin",
                  scope: "workspace",
                },
              },
            ],
          },
          {
            type: "skills_catalog",
            sessionId: "jsonrpc-control",
            mutationBlocked: false,
            clearedMutationPendingKeys: ["plugin:install:workspace"],
            catalog: {
              installations: [
                {
                  installationId: "plugin-1:import-frame:workspace",
                  skillName: "plugin-1:import-frame",
                  displayName: "Import Frame",
                  description: "Import a frame",
                  instructions: "",
                  source: "project",
                  path: "/tmp/workspace/.agents/plugins/plugin-1/skills/import-frame/SKILL.md",
                  scope: "project",
                  enabled: true,
                  sourceLabel: "Project",
                  sourceSortRank: 0,
                },
              ],
              bundled: [],
              warnings: [],
            },
          },
          {
            type: "plugins_catalog",
            sessionId: "jsonrpc-control",
            clearedMutationPendingKeys: ["plugin:install:workspace"],
            catalog: {
              warnings: [],
              plugins: [
                {
                  id: "plugin-1",
                  name: "installed-plugin",
                  displayName: "Installed Plugin",
                  description: "Plugin helpers",
                  scope: "workspace",
                  discoveryKind: "direct",
                  installed: true,
                  enabled: true,
                  rootDir: "/tmp/workspace/.agents/plugins/plugin-1",
                  manifestPath: "/tmp/workspace/.agents/plugins/plugin-1/.codex-plugin/plugin.json",
                  skillsPath: "/tmp/workspace/.agents/plugins/plugin-1/skills",
                  skills: [],
                  mcpServers: [],
                  apps: [],
                  warnings: [],
                },
              ],
              availablePlugins: [],
            },
          },
          {
            type: "mcp_servers",
            sessionId: "jsonrpc-control",
            servers: [
              {
                name: "figma",
                transport: {
                  type: "http",
                  url: "https://figma.example.com",
                },
                source: "plugin",
                inherited: false,
                authMode: "none",
                authScope: "workspace",
                authMessage: "",
                pluginId: "plugin-1",
                pluginName: "installed-plugin",
                pluginDisplayName: "Installed Plugin",
                pluginScope: "workspace",
              },
            ],
            legacy: {
              workspace: {
                path: "/tmp/workspace/.mcp.json",
                exists: false,
              },
              user: {
                path: "/tmp/home/.mcp.json",
                exists: false,
              },
            },
            files: [],
            warnings: [],
          },
        ],
      };
    });

    const helpers = createControlSocketHelpers(deps);
    const ok = await helpers.requestJsonRpcControlEvent(
      get as any,
      set as any,
      workspaceId,
      "cowork/plugins/install",
      { cwd: "/tmp/workspace", sourceInput: "owner/older-repo", targetScope: "workspace" },
    );

    await flushAsyncWork();

    expect(ok).toBe(true);
    expect(waiterResolved).toBe(true);
    expect(state.workspaceRuntimeById[workspaceId].selectedPluginPreview).toEqual(existingPreview);
    expect(state.workspaceRuntimeById[workspaceId].skills).toEqual([
      expect.objectContaining({
        name: "plugin-1:import-frame",
      }),
    ]);
    expect(state.workspaceRuntimeById[workspaceId].skillsCatalog?.installations).toEqual([
      expect.objectContaining({
        skillName: "plugin-1:import-frame",
      }),
    ]);
    expect(state.workspaceRuntimeById[workspaceId].pluginsCatalog?.plugins).toEqual([
      expect.objectContaining({
        id: "plugin-1",
      }),
    ]);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(
      "stale skill mutation error",
    );
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({
      "plugin:preview": true,
    });
    expect(state.workspaceRuntimeById[workspaceId].mcpServers).toEqual([
      expect.objectContaining({
        name: "figma",
        pluginId: "plugin-1",
      }),
    ]);
  });

  test("requestJsonRpcControlEvent resolves plugin install waiters from skill catalog events", async () => {
    const workspaceId = "ws-plugin-install-skills-only";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          pluginMutationPendingKeys: {
            "plugin:install:workspace": true,
          },
        },
      },
    });

    let waiterResolved = false;
    const installWaiter = Promise.withResolvers<void>();
    installWaiter.promise.then(() => {
      waiterResolved = true;
    });
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install:workspace",
      resolve: installWaiter.resolve,
      reject: installWaiter.reject,
    });

    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/install");
      return {
        event: {
          type: "skills_catalog",
          sessionId: "jsonrpc-control",
          mutationBlocked: false,
          clearedMutationPendingKeys: ["plugin:install:workspace"],
          catalog: {
            installations: [],
            bundled: [],
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
      "cowork/plugins/install",
      { cwd: "/tmp/workspace", sourceInput: "owner/repo", targetScope: "workspace" },
    );

    await flushAsyncWork();

    expect(ok).toBe(true);
    expect(waiterResolved).toBe(true);
    expect(RUNTIME.pluginInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBeNull();
  });

  test("requestJsonRpcControlEvent keeps plugin install waiters when the cleared key was not pending", async () => {
    const workspaceId = "ws-plugin-install-stray-clear";
    const { get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginMutationPendingKeys: {},
        },
      },
    });

    let waiterResolved = false;
    const installWaiter = Promise.withResolvers<void>();
    installWaiter.promise.then(() => {
      waiterResolved = true;
    });
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install:workspace",
      resolve: installWaiter.resolve,
      reject: installWaiter.reject,
    });

    installFakeSocket(workspaceId, async (method) => {
      expect(method).toBe("cowork/plugins/install");
      return {
        event: {
          type: "skills_catalog",
          sessionId: "jsonrpc-control",
          mutationBlocked: false,
          clearedMutationPendingKeys: ["plugin:install:workspace"],
          catalog: {
            installations: [],
            bundled: [],
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
      "cowork/plugins/install",
      { cwd: "/tmp/workspace", sourceInput: "owner/repo", targetScope: "workspace" },
    );

    await flushAsyncWork();

    expect(ok).toBe(true);
    expect(waiterResolved).toBe(false);
    expect(RUNTIME.pluginInstallWaiters.has(workspaceId)).toBe(true);
    RUNTIME.pluginInstallWaiters.delete(workspaceId);
  });

  test("requestJsonRpcControlEvent applies error events and rejects pending install waiters", async () => {
    const workspaceId = "ws-error";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          skillCatalogLoading: true,
          skillMutationPendingKeys: { "install:global": true },
        },
      },
    });
    installFakeSocket(workspaceId, async () => ({
      event: {
        type: "error",
        sessionId: "jsonrpc-control",
        source: "session",
        code: "internal_error",
        message: "install failed on disk",
      },
    }));

    const rejected = Promise.withResolvers<void>();
    RUNTIME.skillInstallWaiters.set(workspaceId, {
      pendingKey: "install:global",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    await expect(
      Promise.all([
        helpers.requestJsonRpcControlEvent(
          get as any,
          set as any,
          workspaceId,
          "cowork/skills/install",
          {
            cwd: "/tmp/workspace",
            sourceInput: "foo",
            targetScope: "global",
          },
        ),
        rejected.promise,
      ]),
    ).rejects.toThrow("install failed on disk");

    expect(RUNTIME.skillInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillCatalogLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBe(
      "install failed on disk",
    );
    expect(state.notifications).toHaveLength(1);
  });

  test("requestJsonRpcControlEvent applies plugin mutation errors to the plugin channel", async () => {
    const workspaceId = "ws-plugin-error";
    const { state, get, set } = createState(workspaceId, {
      workspaceRuntimeById: {
        [workspaceId]: {
          ...defaultWorkspaceRuntime(),
          serverUrl: "ws://mock",
          pluginsLoading: true,
          pluginMutationPendingKeys: { "plugin:install:user": true },
        },
      },
    });
    installFakeSocket(workspaceId, async () => ({
      event: {
        type: "error",
        sessionId: "jsonrpc-control",
        source: "session",
        code: "internal_error",
        message: "plugin install failed on disk",
      },
    }));

    const rejected = Promise.withResolvers<void>();
    RUNTIME.pluginInstallWaiters.set(workspaceId, {
      pendingKey: "plugin:install:user",
      resolve: rejected.resolve,
      reject: rejected.reject,
    });

    const helpers = createControlSocketHelpers(deps);
    await expect(
      Promise.all([
        helpers.requestJsonRpcControlEvent(
          get as any,
          set as any,
          workspaceId,
          "cowork/plugins/install",
          {
            cwd: "/tmp/workspace",
            sourceInput: "foo",
            targetScope: "user",
          },
        ),
        rejected.promise,
      ]),
    ).rejects.toThrow("plugin install failed on disk");

    expect(RUNTIME.pluginInstallWaiters.has(workspaceId)).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginsLoading).toBe(false);
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationPendingKeys).toEqual({});
    expect(state.workspaceRuntimeById[workspaceId].pluginMutationError).toBe(
      "plugin install failed on disk",
    );
    expect(state.workspaceRuntimeById[workspaceId].skillMutationError).toBeNull();
    expect(state.workspaceRuntimeById[workspaceId].pluginsError).toBe(
      "plugin install failed on disk",
    );
  });
});
