import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { MemoryStore } from "../src/memoryStore";
import { AgentControl } from "../src/server/agents/AgentControl";
import { startAgentServer } from "../src/server/startServer";
import { AgentSession } from "../src/server/session/AgentSession";
import { WorkspaceBackupService } from "../src/server/workspaceBackups";
import { makeTmpProject, serverOpts, stopTestServer } from "./helpers/wsHarness";

async function connectJsonRpc(url: string) {
  const ws = new WebSocket(`${url}?protocol=jsonrpc`);
  const queue: any[] = [];
  const waiters = new Set<{
    predicate: (message: any) => boolean;
    resolve: (message: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  ws.onmessage = (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : "");
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 5_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (event) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${event}`));
    };
  });

  const waitFor = async (predicate: (message: any) => boolean, timeoutMs = 5_000) => {
    const existingIndex = queue.findIndex(predicate);
    if (existingIndex >= 0) {
      return queue.splice(existingIndex, 1)[0];
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error("Timed out waiting for JSON-RPC message"));
      }, timeoutMs);
      const waiter = { predicate, resolve, reject, timer };
      waiters.add(waiter);
    });
  };

  let nextId = 0;
  const request = async (method: string, params?: unknown, timeoutMs = 5_000) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, ...(params !== undefined ? { params } : {}) }));
    return await waitFor((message) => message.id === id, timeoutMs);
  };

  await request("initialize", {
    clientInfo: {
      name: "jsonrpc-control-test",
    },
  });
  ws.send(JSON.stringify({ method: "initialized" }));

  return {
    ws,
    request,
    waitFor,
    close: () => ws.close(),
  };
}

describe("server JSON-RPC control methods", () => {
  test("provider auth authorize returns the emitted session error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/auth/authorize", {
        cwd: tmpDir,
        provider: "google",
        methodId: "missing_method",
      });

      expect(response.error.message).toContain("Unsupported auth method");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("plugin control methods return catalog and detail events for discovered Codex plugins", async () => {
    const tmpDir = await makeTmpProject();
    const pluginRoot = `${tmpDir}/.agents/plugins/figma-toolkit`;
    await fs.mkdir(`${pluginRoot}/.codex-plugin`, { recursive: true });
    await fs.mkdir(`${pluginRoot}/skills/import-frame`, { recursive: true });
    await fs.writeFile(
      `${pluginRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify({
        name: "figma-toolkit",
        description: "Figma helpers",
        interface: {
          displayName: "Figma Toolkit",
        },
      }, null, 2)}\n`,
    );
    await fs.writeFile(
      `${pluginRoot}/skills/import-frame/SKILL.md`,
      [
        "---",
        "name: import-frame",
        "description: Import a Figma frame",
        "---",
        "",
        "# Import frame",
      ].join("\n"),
    );
    await fs.writeFile(
      `${pluginRoot}/.mcp.json`,
      `${JSON.stringify({
        mcpServers: {
          figma: {
            type: "stdio",
            command: "figma-mcp",
          },
        },
      }, null, 2)}\n`,
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);

      const catalogResponse = await rpc.request("cowork/plugins/catalog/read", {
        cwd: tmpDir,
      });
      expect(catalogResponse.result.event.type).toBe("plugins_catalog");
      expect(catalogResponse.result.event.catalog.plugins).toEqual([
        expect.objectContaining({
          id: "figma-toolkit",
          name: "figma-toolkit",
          displayName: "Figma Toolkit",
          enabled: true,
          scope: "workspace",
          discoveryKind: "direct",
        }),
      ]);

      const pluginId = catalogResponse.result.event.catalog.plugins[0]?.id;
      expect(typeof pluginId).toBe("string");

      const detailResponse = await rpc.request("cowork/plugins/read", {
        cwd: tmpDir,
        pluginId,
      });
      expect(detailResponse.result.event).toEqual(
        expect.objectContaining({
          type: "plugin_detail",
          plugin: expect.objectContaining({
            id: pluginId,
            name: "figma-toolkit",
            displayName: "Figma Toolkit",
          }),
        }),
      );

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace control reads do not persist ephemeral control sessions", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const dbPath = path.join(tmpDir, ".cowork", "sessions.db");
    const countPersistedSessions = () => {
      const db = new Database(dbPath);
      try {
        return Number((db.query("select count(*) as count from sessions").get() as { count: number }).count);
      } finally {
        db.close();
      }
    };

    try {
      const rpc = await connectJsonRpc(url);
      expect(countPersistedSessions()).toBe(0);

      await rpc.request("cowork/skills/catalog/read", { cwd: tmpDir });
      await rpc.request("cowork/plugins/catalog/read", { cwd: tmpDir });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(countPersistedSessions()).toBe(0);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("plugin detail reads fail fast when the requested plugin is missing or ambiguous", async () => {
    const tmpDir = await makeTmpProject();
    const workspacePluginRoot = `${tmpDir}/.agents/plugins/figma-toolkit`;
    await fs.mkdir(`${workspacePluginRoot}/.codex-plugin`, { recursive: true });
    await fs.writeFile(
      `${workspacePluginRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify({
        name: "figma-toolkit",
        description: "Workspace Figma helpers",
        interface: {
          displayName: "Workspace Figma Toolkit",
        },
      }, null, 2)}\n`,
    );

      const homePluginRoot = `${tmpDir}/.cowork-home/.agents/plugins/figma-toolkit`;
    await fs.mkdir(`${homePluginRoot}/.codex-plugin`, { recursive: true });
    await fs.writeFile(
      `${homePluginRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify({
        name: "figma-toolkit",
        description: "User Figma helpers",
        interface: {
          displayName: "User Figma Toolkit",
        },
      }, null, 2)}\n`,
    );

      const { server, url } = await startAgentServer(serverOpts(tmpDir, {
        homedir: `${tmpDir}/.cowork-home`,
      }));

    try {
      const rpc = await connectJsonRpc(url);

      const ambiguousResponse = await rpc.request("cowork/plugins/read", {
        cwd: tmpDir,
        pluginId: "figma-toolkit",
      });
      expect(ambiguousResponse.error?.message).toContain("exists in multiple scopes");
      expect(ambiguousResponse.result).toBeUndefined();

      const missingResponse = await rpc.request("cowork/plugins/read", {
        cwd: tmpDir,
        pluginId: "missing-plugin",
        scope: "workspace",
      });
      expect(missingResponse.error?.message).toContain('Plugin "missing-plugin" was not found in the workspace scope.');
      expect(missingResponse.result).toBeUndefined();

      const scopedResponse = await rpc.request("cowork/plugins/read", {
        cwd: tmpDir,
        pluginId: "figma-toolkit",
        scope: "workspace",
      });
      expect(scopedResponse.result.event).toEqual(
        expect.objectContaining({
          type: "plugin_detail",
          plugin: expect.objectContaining({
            id: "figma-toolkit",
            scope: "workspace",
            displayName: "Workspace Figma Toolkit",
          }),
        }),
      );

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("plugin install preview and install mutate the workspace plugin catalog", async () => {
    const tmpDir = await makeTmpProject();
    const sourceRoot = `${tmpDir}/plugin-source/figma-toolkit`;
    await fs.mkdir(`${sourceRoot}/.codex-plugin`, { recursive: true });
    await fs.mkdir(`${sourceRoot}/skills/import-frame`, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify({
        name: "figma-toolkit",
        description: "Figma helpers",
        interface: {
          displayName: "Figma Toolkit",
        },
      }, null, 2)}\n`,
    );
    await fs.writeFile(
      `${sourceRoot}/skills/import-frame/SKILL.md`,
      [
        "---",
        "name: import-frame",
        "description: Import a Figma frame",
        "---",
        "",
        "# Import frame",
      ].join("\n"),
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);

      const previewResponse = await rpc.request("cowork/plugins/install/preview", {
        cwd: tmpDir,
        sourceInput: sourceRoot,
        targetScope: "workspace",
      });
      expect(previewResponse.result.event).toEqual(
        expect.objectContaining({
          type: "plugin_install_preview",
          preview: expect.objectContaining({
            targetScope: "workspace",
            candidates: [
              expect.objectContaining({
                pluginId: "figma-toolkit",
                displayName: "Figma Toolkit",
                diagnostics: [],
              }),
            ],
          }),
        }),
      );

      const installResponse = await rpc.request("cowork/plugins/install", {
        cwd: tmpDir,
        sourceInput: sourceRoot,
        targetScope: "workspace",
      });
      expect(Array.isArray(installResponse.result.events)).toBe(true);
      expect(installResponse.result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "plugin_install_preview",
            fromUserPreviewRequest: false,
            preview: expect.objectContaining({
              targetScope: "workspace",
              candidates: [
                expect.objectContaining({
                  pluginId: "figma-toolkit",
                }),
              ],
            }),
          }),
          expect.objectContaining({
            type: "skills_list",
            skills: expect.arrayContaining([
              expect.objectContaining({
                name: "figma-toolkit:import-frame",
              }),
            ]),
          }),
          expect.objectContaining({
            type: "skills_catalog",
            catalog: expect.objectContaining({
              installations: expect.arrayContaining([
                expect.objectContaining({
                  name: "figma-toolkit:import-frame",
                }),
              ]),
            }),
          }),
          expect.objectContaining({
            type: "plugins_catalog",
            catalog: expect.objectContaining({
              plugins: [
                expect.objectContaining({
                  id: "figma-toolkit",
                  displayName: "Figma Toolkit",
                  scope: "workspace",
                }),
              ],
            }),
          }),
          expect.objectContaining({
            type: "mcp_servers",
          }),
          expect.objectContaining({
            type: "plugin_detail",
            plugin: expect.objectContaining({
              id: "figma-toolkit",
              scope: "workspace",
            }),
          }),
        ]),
      );

      const installedPluginPath = `${tmpDir}/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json`;
      await expect(fs.stat(installedPluginPath)).resolves.toBeDefined();

      const disableResponse = await rpc.request("cowork/plugins/disable", {
        cwd: tmpDir,
        pluginId: "figma-toolkit",
        scope: "workspace",
      });
      expect(Array.isArray(disableResponse.result.events)).toBe(true);
      const disableSkillsList = disableResponse.result.events.find((event: any) => event.type === "skills_list");
      const disabledSkill = disableSkillsList?.skills.find((skill: any) => skill.name === "figma-toolkit:import-frame");
      expect(disabledSkill).toBeDefined();
      expect(disabledSkill.enabled).toBe(false);
      const disableSkillsCatalog = disableResponse.result.events.find((event: any) => event.type === "skills_catalog");
      const disabledInstallation = disableSkillsCatalog?.catalog.installations.find(
        (installation: any) => installation.name === "figma-toolkit:import-frame",
      );
      expect(disabledInstallation).toBeDefined();
      expect(disabledInstallation.enabled).toBe(false);
      const disablePluginsCatalog = disableResponse.result.events.find((event: any) => event.type === "plugins_catalog");
      expect(
        disablePluginsCatalog?.catalog.plugins.find((plugin: any) => plugin.id === "figma-toolkit"),
      ).toEqual(expect.objectContaining({ enabled: false, scope: "workspace" }));
      const disableMcpServers = disableResponse.result.events.find((event: any) => event.type === "mcp_servers");
      expect(disableMcpServers?.servers.find((server: any) => server.name === "figma")).toBeUndefined();

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("plugin installs allow enough time for slower mutation event streams", async () => {
    const tmpDir = await makeTmpProject();
    const sourceRoot = `${tmpDir}/plugin-source/figma-toolkit`;
    await fs.mkdir(`${sourceRoot}/.codex-plugin`, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify({
        name: "figma-toolkit",
        description: "Figma helpers",
        interface: {
          displayName: "Figma Toolkit",
        },
      }, null, 2)}\n`,
    );

    const originalInstallPlugins = AgentSession.prototype.installPlugins;
    AgentSession.prototype.installPlugins = async function (sourceInput: string, targetScope: "workspace" | "user") {
      await new Promise((resolve) => setTimeout(resolve, 5_250));
      await originalInstallPlugins.call(this, sourceInput, targetScope);
    };

    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const installResponse = await rpc.request("cowork/plugins/install", {
        cwd: tmpDir,
        sourceInput: sourceRoot,
        targetScope: "workspace",
      }, 15_000);

      expect(Array.isArray(installResponse.result.events)).toBe(true);
      expect(installResponse.result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "plugin_install_preview",
          }),
          expect.objectContaining({
            type: "plugins_catalog",
          }),
        ]),
      );

      rpc.close();
    } finally {
      AgentSession.prototype.installPlugins = originalInstallPlugins;
      await stopTestServer(server);
    }
  }, 15_000);

  test("plugin workspace installs follow the request cwd instead of the server startup cwd", async () => {
    const serverRoot = await makeTmpProject("agent-harness-server-");
    const targetWorkspace = await makeTmpProject("agent-harness-target-");
    const sourceRoot = `${targetWorkspace}/plugin-source/figma-toolkit`;
    await fs.mkdir(`${sourceRoot}/.codex-plugin`, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify({
        name: "figma-toolkit",
        description: "Figma helpers",
        interface: {
          displayName: "Figma Toolkit",
        },
      }, null, 2)}\n`,
    );

    const { server, url } = await startAgentServer(serverOpts(serverRoot));

    try {
      const rpc = await connectJsonRpc(url);
      const installResponse = await rpc.request("cowork/plugins/install", {
        cwd: targetWorkspace,
        sourceInput: sourceRoot,
        targetScope: "workspace",
      });

      expect(Array.isArray(installResponse.result.events)).toBe(true);
      await expect(fs.stat(`${targetWorkspace}/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json`)).resolves.toBeDefined();
      await expect(fs.stat(`${serverRoot}/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json`)).rejects.toBeDefined();

      const catalogResponse = await rpc.request("cowork/plugins/catalog/read", {
        cwd: targetWorkspace,
      });
      expect(catalogResponse.result.event.catalog.plugins).toEqual([
        expect.objectContaining({
          id: "figma-toolkit",
          scope: "workspace",
        }),
      ]);

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("shared skill installs notify subscribed control clients with refreshed catalog state", async () => {
    const tmpDir = await makeTmpProject("agent-harness-plugin-notify-");
    const sourceRoot = `${tmpDir}/skill-source/example-skill`;
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/SKILL.md`,
      [
        "---",
        "name: example-skill",
        "description: Example skill",
        "---",
        "",
        "# Example skill",
      ].join("\n"),
    );

    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const subscriber = await connectJsonRpc(url);
      const mutator = await connectJsonRpc(url);

      await subscriber.request("cowork/plugins/catalog/read", {
        cwd: tmpDir,
      });

      const installResponse = await mutator.request("cowork/skills/install", {
        cwd: tmpDir,
        sourceInput: sourceRoot,
        targetScope: "global",
      });
      expect(installResponse.error).toBeUndefined();
      expect(installResponse.result.event).toEqual(
        expect.objectContaining({
          type: "skills_catalog",
        }),
      );

      const notification = await subscriber.waitFor(
        (message) => message.method === "cowork/control/event" && message.params?.type === "skills_catalog",
      );
      expect(notification.params.cwd).toBe(tmpDir);
      expect(notification.params.catalog.installations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "example-skill",
            scope: "global",
          }),
        ]),
      );

      subscriber.close();
      mutator.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session state read returns the workspace control config bundle", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {
        cwd: tmpDir,
      });

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      const configUpdated = response.result.events[0];
      const sessionSettings = response.result.events[1];
      const sessionConfig = response.result.events[2];
      expect(configUpdated.config.provider).toBe("google");
      expect(configUpdated.config.workingDirectory).toBe(tmpDir);
      expect(sessionSettings.enableMcp).toBe(true);
      expect(sessionConfig.config.defaultBackupsEnabled).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace control reads and persists the target workspace config", async () => {
    const serverRoot = await makeTmpProject("agent-harness-server-config-");
    const targetWorkspace = await makeTmpProject("agent-harness-target-config-");
    await fs.writeFile(
      `${targetWorkspace}/.agent/config.json`,
      `${JSON.stringify({
        provider: "openai",
        model: "gpt-5.4",
        preferredChildModel: "gpt-5.4",
        enableMcp: false,
        enableMemory: false,
      }, null, 2)}\n`,
    );

    const { server, url } = await startAgentServer(serverOpts(serverRoot, {
      env: {
        AGENT_PROVIDER: undefined,
      },
    }));

    try {
      const rpc = await connectJsonRpc(url);
      const stateResponse = await rpc.request("cowork/session/state/read", {
        cwd: targetWorkspace,
      });

      expect(stateResponse.result.events[0]?.config?.provider).toBe("openai");
      expect(stateResponse.result.events[0]?.config?.model).toBe("gpt-5.4");
      expect(stateResponse.result.events[0]?.config?.workingDirectory).toBe(targetWorkspace);
      expect(stateResponse.result.events[1]?.enableMcp).toBe(false);
      expect(stateResponse.result.events[2]?.config?.enableMemory).toBe(false);

      const defaultsResponse = await rpc.request("cowork/session/defaults/apply", {
        cwd: targetWorkspace,
        config: {
          enableMemory: true,
        },
      });
      expect(defaultsResponse.result.event.type).toBe("session_config");

      const targetConfig = JSON.parse(await fs.readFile(`${targetWorkspace}/.agent/config.json`, "utf-8"));
      expect(targetConfig.enableMemory).toBe(true);
      await expect(fs.readFile(`${serverRoot}/.agent/config.json`, "utf-8")).rejects.toBeDefined();

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("shared control notifications include the workspace cwd for sockets subscribed to multiple workspaces", async () => {
    const workspaceA = await makeTmpProject("agent-harness-plugin-notify-a-");
    const workspaceB = await makeTmpProject("agent-harness-plugin-notify-b-");
    const sourceRoot = `${workspaceB}/skill-source/example-skill`;
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/SKILL.md`,
      [
        "---",
        "name: example-skill",
        "description: Example skill",
        "---",
        "",
        "# Example skill",
      ].join("\n"),
    );

    const { server, url } = await startAgentServer(serverOpts(workspaceA));

    try {
      const subscriber = await connectJsonRpc(url);
      const mutator = await connectJsonRpc(url);

      await subscriber.request("cowork/plugins/catalog/read", {
        cwd: workspaceA,
      });
      await subscriber.request("cowork/plugins/catalog/read", {
        cwd: workspaceB,
      });

      const installResponse = await mutator.request("cowork/skills/install", {
        cwd: workspaceB,
        sourceInput: sourceRoot,
        targetScope: "global",
      });
      expect(installResponse.error).toBeUndefined();

      const workspaceBNotification = await subscriber.waitFor(
        (message) =>
          message.method === "cowork/control/event"
          && message.params?.type === "skills_catalog"
          && message.params?.cwd === workspaceB,
      );
      expect(workspaceBNotification.params.cwd).toBe(workspaceB);

      await expect(
        subscriber.waitFor(
          (message) =>
            message.method === "cowork/control/event"
            && message.params?.type === "skills_catalog"
            && message.params?.cwd === workspaceA,
          200,
        ),
      ).rejects.toThrow("Timed out waiting for JSON-RPC message");

      subscriber.close();
      mutator.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace control skill installs resolve relative sources from the request cwd", async () => {
    const serverRoot = await makeTmpProject("agent-harness-server-skill-root-");
    const targetWorkspace = await makeTmpProject("agent-harness-target-skill-root-");
    const sourceRoot = `${targetWorkspace}/skill-source/example-skill`;
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(
      `${sourceRoot}/SKILL.md`,
      [
        "---",
        "name: example-skill",
        "description: Example skill",
        "---",
        "",
        "# Example skill",
      ].join("\n"),
    );

    const { server, url } = await startAgentServer(serverOpts(serverRoot));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/install", {
        cwd: targetWorkspace,
        sourceInput: "skill-source/example-skill",
        targetScope: "project",
      });

      expect(response.result.event).toEqual(
        expect.objectContaining({
          type: "skills_catalog",
          catalog: expect.objectContaining({
            installations: expect.arrayContaining([
              expect.objectContaining({
                name: "example-skill",
                scope: "project",
              }),
            ]),
          }),
        }),
      );
      await expect(fs.stat(`${targetWorkspace}/.agent/skills/example-skill/SKILL.md`)).resolves.toBeDefined();
      await expect(fs.stat(`${serverRoot}/.agent/skills/example-skill/SKILL.md`)).rejects.toBeDefined();

      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session state read defaults omitted cwd to the server working directory", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/state/read", {});

      expect(response.result.events.map((event: any) => event.type)).toEqual([
        "config_updated",
        "session_settings",
        "session_config",
      ]);
      expect(response.result.events[0]?.config?.workingDirectory).toBe(tmpDir);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider catalog read returns a legacy-compatible provider_catalog event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/catalog/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_catalog");
      expect(Array.isArray(response.result.event.all)).toBe(true);
      expect(response.result.event.default.google).toBeDefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider auth methods read returns a legacy-compatible provider_auth_methods event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/authMethods/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_auth_methods");
      expect(response.result.event.methods.google).toEqual(expect.any(Array));
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("provider status refresh returns a legacy-compatible provider_status event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/provider/status/refresh", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("provider_status");
      expect(Array.isArray(response.result.event.providers)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("memory list returns a legacy-compatible memory_list event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/memory/list", {
        cwd: tmpDir,
      });

      expect(response.result.event).toEqual({
        type: "memory_list",
        sessionId: expect.any(String),
        memories: [],
      });
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("MCP servers read returns a legacy-compatible mcp_servers event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/mcp/servers/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("mcp_servers");
      expect(Array.isArray(response.result.event.servers)).toBe(true);
      expect(response.result.event.legacy.workspace.path).toContain("mcp-servers.json");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("skills catalog read returns a legacy-compatible skills_catalog event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/catalog/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("skills_catalog");
      expect(Array.isArray(response.result.event.catalog.installations)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace backups read returns a legacy-compatible workspace_backups event payload", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/backups/workspace/read", {
        cwd: tmpDir,
      });

      expect(response.result.event.type).toBe("workspace_backups");
      expect(response.result.event.workspacePath).toBe(tmpDir);
      expect(Array.isArray(response.result.event.backups)).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  for (const method of [
    "cowork/skills/disable",
    "cowork/skills/enable",
    "cowork/skills/delete",
  ] as const) {
    test(`${method} returns a session error when the skill mutation is rejected`, async () => {
      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(method, {
          cwd: tmpDir,
          skillName: "missing-skill",
        });

        expect(response.error.message).toContain('Skill "missing-skill" not found.');
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    });
  }

  test("cowork/skills/installation/checkUpdate returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/installation/checkUpdate", {
        cwd: tmpDir,
        installationId: "missing-installation",
      });

      expect(response.error.message).toContain('Skill installation "missing-installation" was not found');
      expect(response.result).toBeUndefined();
      rpc.close();
      } finally {
        await stopTestServer(server);
      }
  });

  test("cowork/skills/installation/read returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/skills/installation/read", {
        cwd: tmpDir,
        installationId: "   ",
      });

      expect(response.error.message).toContain("Installation ID is required");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  for (const method of [
    "cowork/skills/installation/enable",
    "cowork/skills/installation/disable",
    "cowork/skills/installation/delete",
    "cowork/skills/installation/update",
  ] as const) {
    test(`${method} returns the emitted validation error instead of timing out`, async () => {
      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(method, {
          cwd: tmpDir,
          installationId: "missing-installation",
        });

        expect(response.error.message).toContain('Skill installation "missing-installation" was not found');
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        await stopTestServer(server);
      }
    });
  }

  for (const scenario of [
    {
      name: "list",
      method: "cowork/memory/list",
      patch: "list" as const,
      params: (cwd: string) => ({ cwd }),
      expectedMessage: "mock memory list failure",
    },
    {
      name: "upsert",
      method: "cowork/memory/upsert",
      patch: "upsert" as const,
      params: (cwd: string) => ({ cwd, scope: "workspace", content: "remember this" }),
      expectedMessage: "mock memory upsert failure",
    },
    {
      name: "delete",
      method: "cowork/memory/delete",
      patch: "remove" as const,
      params: (cwd: string) => ({ cwd, scope: "workspace", id: "memory-1" }),
      expectedMessage: "mock memory delete failure",
    },
  ] as const) {
    test(`${scenario.method} returns the emitted memory error instead of timing out`, async () => {
      const original = MemoryStore.prototype[scenario.patch];
      (MemoryStore.prototype as any)[scenario.patch] = async function (...args: unknown[]) {
        throw new Error(scenario.expectedMessage);
      };

      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(scenario.method, scenario.params(tmpDir));

        expect(response.error.message).toContain(scenario.expectedMessage);
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        (MemoryStore.prototype as any)[scenario.patch] = original;
        await stopTestServer(server);
      }
    });
  }

  for (const scenario of [
    {
      name: "read",
      method: "cowork/backups/workspace/read",
      patch: "listWorkspaceBackups" as const,
      params: (cwd: string) => ({ cwd }),
      expectedMessage: "mock backup read failure",
    },
    {
      name: "delta",
      method: "cowork/backups/workspace/delta/read",
      patch: "getCheckpointDelta" as const,
      params: (cwd: string) => ({ cwd, targetSessionId: "thread-1", checkpointId: "cp-1" }),
      expectedMessage: "mock backup delta failure",
    },
    {
      name: "checkpoint",
      method: "cowork/backups/workspace/checkpoint",
      patch: "createCheckpoint" as const,
      params: (cwd: string) => ({ cwd, targetSessionId: "thread-1" }),
      expectedMessage: "mock backup checkpoint failure",
    },
  ] as const) {
    test(`${scenario.method} returns the emitted backup error instead of timing out`, async () => {
      const original = WorkspaceBackupService.prototype[scenario.patch];
      (WorkspaceBackupService.prototype as any)[scenario.patch] = async function (...args: unknown[]) {
        throw new Error(scenario.expectedMessage);
      };

      const tmpDir = await makeTmpProject();
      const { server, url } = await startAgentServer(serverOpts(tmpDir));

      try {
        const rpc = await connectJsonRpc(url);
        const response = await rpc.request(scenario.method, scenario.params(tmpDir));

        expect(response.error.message).toContain(scenario.expectedMessage);
        expect(response.result).toBeUndefined();
        rpc.close();
      } finally {
        (WorkspaceBackupService.prototype as any)[scenario.patch] = original;
        await stopTestServer(server);
      }
    });
  }

  test("session control methods return legacy-compatible event payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;

      const renamed = await rpc.request("cowork/session/title/set", {
        threadId,
        title: "Renamed session",
      });
      expect(renamed.result.event.type).toBe("session_info");
      expect(renamed.result.event.title).toBe("Renamed session");

      const modelUpdated = await rpc.request("cowork/session/model/set", {
        threadId,
        provider: "google",
        model: "gemini-3-flash-preview",
      });
      expect(modelUpdated.result.event.type).toBe("config_updated");
      expect(modelUpdated.result.event.config.model).toBe("gemini-3-flash-preview");

      const usageUpdated = await rpc.request("cowork/session/usageBudget/set", {
        threadId,
        stopAtUsd: null,
      });
      expect(usageUpdated.result.event.type).toBe("session_usage");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session agent inspect returns the detailed inspect payload", async () => {
    const originalInspect = AgentControl.prototype.inspect;
    (AgentControl.prototype as any).inspect = async function inspectMock() {
      return {
        agent: {
          agentId: "child-1",
          parentSessionId: "thread-1",
          role: "worker",
          mode: "collaborative",
          depth: 1,
          effectiveModel: "gpt-5.4",
          title: "child",
          provider: "openai",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          lifecycleState: "closed",
          executionState: "completed",
          busy: false,
          lastMessagePreview: "done",
        },
        latestAssistantText: "done\n\n```json\n{\"status\":\"completed\",\"summary\":\"Task done\"}\n```",
        parsedReport: {
          status: "completed",
          summary: "Task done",
        },
        sessionUsage: null,
        lastTurnUsage: null,
      };
    };

    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const threadId = created.result.thread.id as string;
      const response = await rpc.request("cowork/session/agent/inspect", {
        threadId,
        agentId: "child-1",
      });

      expect(response.result.event.agent.agentId).toBe("child-1");
      expect(response.result.event.latestAssistantText).toContain("done");
      expect(response.result.event.parsedReport.summary).toBe("Task done");
      rpc.close();
    } finally {
      (AgentControl.prototype as any).inspect = originalInspect;
      await stopTestServer(server);
    }
  });

  test("workspace file upload returns the saved path in a legacy event envelope", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: Buffer.from("hello upload").toString("base64"),
      });

      expect(response.result.event.type).toBe("file_uploaded");
      expect(response.result.event.filename).toBe("upload.txt");
      await expect(fs.readFile(response.result.event.path, "utf8")).resolves.toBe("hello upload");
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("workspace file upload rejects malformed base64 payloads", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const response = await rpc.request("cowork/session/file/upload", {
        cwd: tmpDir,
        filename: "upload.txt",
        contentBase64: "!not-base64!",
      });

      expect(response.error.message).toBe("Invalid base64 file contents");
      await expect(fs.readdir(`${tmpDir}/User Uploads`)).rejects.toThrow();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session model set returns the current config when the selected model is unchanged", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const thread = created.result.thread;
      const response = await rpc.request("cowork/session/model/set", {
        threadId: thread.id,
        provider: thread.modelProvider,
        model: thread.model,
      });

      expect(response.result.event.type).toBe("config_updated");
      expect(response.result.event.config.provider).toBe(thread.modelProvider);
      expect(response.result.event.config.model).toBe(thread.model);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session config set returns the current config event when the patch is a no-op", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const response = await rpc.request("cowork/session/config/set", {
        threadId: created.result.thread.id,
        config: {},
      });

      expect(response.result.event.type).toBe("session_config");
      expect(response.result.event.config.defaultBackupsEnabled).toBe(true);
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });

  test("session usage budget returns the emitted validation error instead of timing out", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const created = await rpc.request("thread/start", { cwd: tmpDir });
      const response = await rpc.request("cowork/session/usageBudget/set", {
        threadId: created.result.thread.id,
        warnAtUsd: 5,
        stopAtUsd: 1,
      });

      expect(response.error.message).toContain("Warning threshold must be less than the hard-stop threshold");
      expect(response.result).toBeUndefined();
      rpc.close();
    } finally {
      await stopTestServer(server);
    }
  });
});
