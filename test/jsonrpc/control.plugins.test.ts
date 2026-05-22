import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { MemoryStore } from "../../src/memoryStore";
import { AgentControl } from "../../src/server/agents/AgentControl";
import { AgentSession } from "../../src/server/session/AgentSession";
import { startAgentServer } from "../../src/server/startServer";
import { WorkspaceBackupService } from "../../src/server/workspaceBackups";
import { makeTmpProject, serverOpts, stopTestServer } from "../helpers/wsHarness";
import { connectJsonRpc, enableProjectBackups } from "./control.harness";

describe("server JSON-RPC control methods", () => {

  test("plugin control methods return catalog and detail events for discovered Codex plugins", async () => {
    const tmpDir = await makeTmpProject();
    const pluginRoot = `${tmpDir}/.agents/plugins/figma-toolkit`;
    await fs.mkdir(`${pluginRoot}/.codex-plugin`, { recursive: true });
    await fs.mkdir(`${pluginRoot}/skills/import-frame`, { recursive: true });
    await fs.writeFile(
      `${pluginRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "Figma helpers",
          interface: {
            displayName: "Figma Toolkit",
          },
        },
        null,
        2,
      )}\n`,
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
      `${JSON.stringify(
        {
          mcpServers: {
            figma: {
              type: "stdio",
              command: "figma-mcp",
            },
          },
        },
        null,
        2,
      )}\n`,
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
  }, 15_000);

  test("workspace control reads do not persist ephemeral control sessions", async () => {
    const tmpDir = await makeTmpProject();
    const { server, url } = await startAgentServer(serverOpts(tmpDir));
    const dbPath = path.join(tmpDir, ".cowork", "sessions.db");
    const countPersistedSessions = () => {
      const db = new Database(dbPath);
      try {
        return Number(
          (db.query("select count(*) as count from sessions").get() as { count: number }).count,
        );
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
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "Workspace Figma helpers",
          interface: {
            displayName: "Workspace Figma Toolkit",
          },
        },
        null,
        2,
      )}\n`,
    );

    const homePluginRoot = `${tmpDir}/.cowork-home/.agents/plugins/figma-toolkit`;
    await fs.mkdir(`${homePluginRoot}/.codex-plugin`, { recursive: true });
    await fs.writeFile(
      `${homePluginRoot}/.codex-plugin/plugin.json`,
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "User Figma helpers",
          interface: {
            displayName: "User Figma Toolkit",
          },
        },
        null,
        2,
      )}\n`,
    );

    const { server, url } = await startAgentServer(
      serverOpts(tmpDir, {
        homedir: `${tmpDir}/.cowork-home`,
      }),
    );

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
      expect(missingResponse.error?.message).toContain(
        'Plugin "missing-plugin" was not found in the workspace scope.',
      );
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
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "Figma helpers",
          interface: {
            displayName: "Figma Toolkit",
          },
        },
        null,
        2,
      )}\n`,
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
      const disableSkillsList = disableResponse.result.events.find(
        (event: any) => event.type === "skills_list",
      );
      const disabledSkill = disableSkillsList?.skills.find(
        (skill: any) => skill.name === "figma-toolkit:import-frame",
      );
      expect(disabledSkill).toBeDefined();
      expect(disabledSkill.enabled).toBe(false);
      const disableSkillsCatalog = disableResponse.result.events.find(
        (event: any) => event.type === "skills_catalog",
      );
      const disabledInstallation = disableSkillsCatalog?.catalog.installations.find(
        (installation: any) => installation.name === "figma-toolkit:import-frame",
      );
      expect(disabledInstallation).toBeDefined();
      expect(disabledInstallation.enabled).toBe(false);
      const disablePluginsCatalog = disableResponse.result.events.find(
        (event: any) => event.type === "plugins_catalog",
      );
      expect(
        disablePluginsCatalog?.catalog.plugins.find((plugin: any) => plugin.id === "figma-toolkit"),
      ).toEqual(expect.objectContaining({ enabled: false, scope: "workspace" }));
      const disableMcpServers = disableResponse.result.events.find(
        (event: any) => event.type === "mcp_servers",
      );
      expect(
        disableMcpServers?.servers.find((server: any) => server.name === "figma"),
      ).toBeUndefined();

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
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "Figma helpers",
          interface: {
            displayName: "Figma Toolkit",
          },
        },
        null,
        2,
      )}\n`,
    );

    const originalInstallPlugins = AgentSession.prototype.installPlugins;
    AgentSession.prototype.installPlugins = async function (
      sourceInput: string,
      targetScope: "workspace" | "user",
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5_250));
      await originalInstallPlugins.call(this, sourceInput, targetScope);
    };

    const { server, url } = await startAgentServer(serverOpts(tmpDir));

    try {
      const rpc = await connectJsonRpc(url);
      const installResponse = await rpc.request(
        "cowork/plugins/install",
        {
          cwd: tmpDir,
          sourceInput: sourceRoot,
          targetScope: "workspace",
        },
        15_000,
      );

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
      `${JSON.stringify(
        {
          name: "figma-toolkit",
          description: "Figma helpers",
          interface: {
            displayName: "Figma Toolkit",
          },
        },
        null,
        2,
      )}\n`,
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
      await expect(
        fs.stat(`${targetWorkspace}/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json`),
      ).resolves.toBeDefined();
      await expect(
        fs.stat(`${serverRoot}/.agents/plugins/figma-toolkit/.codex-plugin/plugin.json`),
      ).rejects.toBeDefined();

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
    const realTmpDir = await fs.realpath(tmpDir);
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
        (message) =>
          message.method === "cowork/control/event" && message.params?.type === "skills_catalog",
      );
      expect(notification.params.cwd).toBe(realTmpDir);
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

});
