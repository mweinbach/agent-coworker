import { describe, expect, test } from "bun:test";
import {
  MockJsonRpcSocket,
  RUNTIME,
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
  makeThread,
  makeThreadListEntry,
  persistCalls,
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
          skillMutationPendingKeys: {
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
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({
      other: true,
    });
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
          skillMutationPendingKeys: {
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
    expect(state.workspaceRuntimeById[workspaceId].skillMutationPendingKeys).toEqual({});
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
          skillMutationPendingKeys: {
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
    expect(state.workspaceRuntimeById[workspaceId].mcpServers).toEqual([
      expect.objectContaining({
        name: "figma",
        pluginId: "plugin-1",
      }),
    ]);
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

});
