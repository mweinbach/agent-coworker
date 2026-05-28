import { describe, expect, test } from "bun:test";
import {
  createControlSocketHelpers,
  createState,
  defaultWorkspaceRuntime,
  deps,
  flushAsyncWork,
  installFakeSocket,
  RUNTIME,
  registerControlSocketLifecycleHooks,
} from "./control-socket.harness";

describe("control socket plugin install events", () => {
  registerControlSocketLifecycleHooks();

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
